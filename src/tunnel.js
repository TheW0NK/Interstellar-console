'use strict';
/**
 * Built-in remote access: so nobody has to forward a port on their router.
 *
 * The panel launches a tunnel client (cloudflared or tailscale) as a child
 * process. That client opens an OUTBOUND connection to its provider's edge,
 * and the provider forwards visitors back down it to this panel on
 * 127.0.0.1. Nothing on the user's network ever accepts an inbound
 * connection, so there's no port to open, no NAT/CGNAT problems, and the
 * panel itself can stay bound to loopback.
 *
 * Providers:
 *   cloudflare (token)  — named Cloudflare Tunnel, your own hostname. The
 *                         public hostname is set up in the Cloudflare
 *                         dashboard; you paste the tunnel token here.
 *   cloudflare (quick)  — no account, no token. Cloudflare hands out a
 *                         random https://<words>.trycloudflare.com URL that
 *                         changes on every restart. Good for testing.
 *   tailscale  (funnel) — public https://<machine>.<tailnet>.ts.net URL.
 *   tailscale  (serve)  — same URL, but only reachable from devices on your
 *                         own tailnet. Not public at all.
 *
 * The tunnel's lifetime is tied to the panel's: it starts when the panel
 * starts, is restarted with backoff if it crashes, and is stopped when the
 * panel exits.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const URL_PATTERNS = {
  cloudflare: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  tailscale: /https:\/\/[a-z0-9.-]+\.ts\.net\/?/i,
};

const MIN_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const STABLE_AFTER_MS = 60000;

class TunnelManager extends EventEmitter {
  /**
   * @param {object} tunnelConfig  the `tunnel:` block of config.yml
   * @param {object} target        { host, port } the panel is listening on
   */
  constructor(tunnelConfig, target) {
    super();
    this.cfg = tunnelConfig || {};
    this.target = target;
    this.child = null;
    this.stopping = false;
    this.backoffMs = MIN_BACKOFF_MS;
    this.restartTimer = null;
    this.stableTimer = null;
    this.recentLog = [];
    this.status = {
      enabled: !!this.cfg.enabled,
      provider: this.cfg.provider || null,
      mode: null,
      state: this.cfg.enabled ? 'starting' : 'disabled', // disabled | starting | connected | restarting | error | stopped
      url: null,
      error: null,
      since: Date.now(),
      restarts: 0,
    };
  }

  /** Resolves the command, args and env for the configured provider, or throws a readable error. */
  buildCommand() {
    const provider = String(this.cfg.provider || '').toLowerCase();
    const localUrl = `http://${this.target.host}:${this.target.port}`;

    if (provider === 'cloudflare') {
      const cf = this.cfg.cloudflare || {};
      const bin = cf.binary || 'cloudflared';
      // Prefer the env var so the token never has to sit in config.yml (and
      // never shows up in `ps` either — cloudflared reads TUNNEL_TOKEN itself).
      const token = process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN || cf.token || '';
      const hasToken = token && token !== 'CHANGE_ME';
      if (hasToken) {
        return {
          mode: 'token',
          bin,
          args: ['tunnel', '--no-autoupdate', 'run'],
          env: { ...process.env, TUNNEL_TOKEN: token },
          // Named tunnels don't print their hostname — it's configured in
          // the Cloudflare dashboard — so the URL is whatever the user tells us.
          staticUrl: cf.hostname ? normalizeUrl(cf.hostname) : null,
        };
      }
      return {
        mode: 'quick',
        bin,
        args: ['tunnel', '--no-autoupdate', '--url', localUrl],
        env: process.env,
        staticUrl: null,
      };
    }

    if (provider === 'tailscale') {
      const ts = this.cfg.tailscale || {};
      const bin = ts.binary || 'tailscale';
      const mode = String(ts.mode || 'funnel').toLowerCase();
      if (mode !== 'funnel' && mode !== 'serve') {
        throw new Error(`tunnel.tailscale.mode must be "funnel" or "serve", got "${ts.mode}"`);
      }
      // Foreground (no --bg) on purpose: when this child exits, Tailscale
      // stops forwarding, so the tunnel never outlives the panel.
      return { mode, bin, args: [mode, String(this.target.port)], env: process.env, staticUrl: null };
    }

    throw new Error(`tunnel.provider must be "cloudflare" or "tailscale", got "${this.cfg.provider}"`);
  }

  start() {
    if (!this.cfg.enabled) return;
    this.stopping = false;
    this.fatal = false;
    this.launch();
  }

  launch() {
    let cmd;
    try {
      cmd = this.buildCommand();
    } catch (err) {
      this.setStatus({ state: 'error', error: err.message });
      console.error(`[tunnel] ${err.message}`);
      return;
    }
    this.status.mode = cmd.mode;
    this.setStatus({ state: this.status.restarts ? 'restarting' : 'starting', url: cmd.staticUrl, error: null });
    console.log(`[tunnel] starting ${this.status.provider} (${cmd.mode}) -> http://${this.target.host}:${this.target.port}`);

    let child;
    try {
      child = spawn(cmd.bin, cmd.args, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.onSpawnError(err, cmd);
      return;
    }
    this.child = child;

    const onData = (buf) => {
      const text = buf.toString();
      text.split(/\r?\n/).filter(Boolean).forEach((line) => this.handleLine(line, cmd));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => this.onSpawnError(err, cmd));
    child.on('exit', (code, signal) => this.onExit(code, signal));

    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => { this.backoffMs = MIN_BACKOFF_MS; }, STABLE_AFTER_MS);
  }

  handleLine(line, cmd) {
    this.recentLog.push(line);
    if (this.recentLog.length > 50) this.recentLog.shift();
    if (this.cfg.logOutput) console.log(`[tunnel] ${line}`);

    const pattern = URL_PATTERNS[this.status.provider];
    const match = pattern && line.match(pattern);
    if (match && !cmd.staticUrl) {
      const url = normalizeUrl(match[0]);
      if (url !== this.status.url) {
        console.log(`[tunnel] panel is reachable at ${url}`);
        this.setStatus({ state: 'connected', url });
      } else if (this.status.state !== 'connected') {
        this.setStatus({ state: 'connected' });
      }
      return;
    }
    // Named Cloudflare tunnels: no URL is printed, but a registered edge
    // connection means traffic will flow.
    if (/Registered tunnel connection/i.test(line) && this.status.state !== 'connected') {
      console.log(`[tunnel] connected${cmd.staticUrl ? ` — ${cmd.staticUrl}` : ''}`);
      this.setStatus({ state: 'connected' });
      return;
    }
    // Tailscale prints these when Funnel/Serve can't be used yet.
    if (/funnel.*not (enabled|available)|must be enabled|not logged in|NeedsLogin|tailscaled.*not running|access denied/i.test(line)) {
      this.setStatus({ error: line.trim() });
    }
  }

  onSpawnError(err, cmd) {
    if (err && err.code === 'ENOENT') {
      const hint = this.status.provider === 'tailscale'
        ? 'Install Tailscale (https://tailscale.com/download) and run `tailscale up` once, or set tunnel.tailscale.binary to its full path.'
        : 'Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or set tunnel.cloudflare.binary to its full path.';
      const msg = `"${cmd.bin}" was not found. ${hint}`;
      console.error(`[tunnel] ${msg}`);
      this.child = null;
      this.fatal = true;
      // Not worth retrying in a loop — the binary won't appear on its own.
      this.setStatus({ state: 'error', error: msg, url: null });
      return;
    }
    console.error(`[tunnel] failed to start: ${err.message}`);
    this.setStatus({ error: err.message });
  }

  onExit(code, signal) {
    this.child = null;
    clearTimeout(this.stableTimer);
    if (this.stopping) {
      this.setStatus({ state: 'stopped', url: null });
      return;
    }
    if (this.fatal) return;

    const last = this.recentLog.slice(-3).join(' | ');
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    console.error(`[tunnel] exited (${why}); retrying in ${Math.round(this.backoffMs / 1000)}s${last ? ` — last output: ${last}` : ''}`);
    this.status.restarts += 1;
    this.setStatus({
      state: 'restarting',
      url: null,
      error: this.status.error || `Tunnel client exited (${why})`,
    });
    this.restartTimer = setTimeout(() => this.launch(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    if (this.child) {
      const child = this.child;
      try { child.kill('SIGTERM'); } catch (err) { /* already gone */ }
      // A client that ignores SIGTERM must not outlive the panel.
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } } }, 3000).unref();
    } else if (this.cfg.enabled) {
      this.setStatus({ state: 'stopped', url: null });
    }
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    if (patch.state) this.status.since = Date.now();
    this.emit('status', this.getStatus());
  }

  /** Stops the tunnel and resolves once the client has exited (or after timeoutMs, killing it). */
  stopAndWait(timeoutMs = 2000) {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(); }, timeoutMs);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  getStatus() {
    return { ...this.status };
  }
}

function normalizeUrl(u) {
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

/** Where the tunnel should send traffic. A wildcard bind is reachable on loopback. */
function tunnelTarget(panelConfig) {
  const bind = panelConfig.bind || '127.0.0.1';
  const host = (bind === '0.0.0.0' || bind === '::' || bind === '') ? '127.0.0.1' : bind;
  return { host, port: panelConfig.port };
}

module.exports = { TunnelManager, tunnelTarget };
