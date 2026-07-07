'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const DONE_RE = /Done \(/;
const ANSI_RUN = '(?:\\x1b\\[[0-9;]*m)*';
// Tolerates ANSI escape codes interspersed around the timestamp/level/colon
// (common — Paper colorizes the whole bracket by level) while preserving
// any ANSI still embedded in the message body itself (e.g. colored chat)
// so the frontend can render it instead of showing raw escape junk.
const LOG_RE = new RegExp(
  '^' + ANSI_RUN + '\\[(\\d{2}:\\d{2}:\\d{2})' + ANSI_RUN + '\\s+' + ANSI_RUN +
  '(INFO|WARN|ERROR|DEBUG)' + ANSI_RUN + '\\]:' + ANSI_RUN + '\\s?'
);
const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

const VALID_STATES = ['offline', 'starting', 'online', 'stopping', 'restarting'];

// How long to wait after a command for the server to finish printing its
// response to the console: resolve early once output goes quiet, but never
// wait longer than the hard cap. There's no request/response framing on
// stdin like there is with RCON, so this is a best-effort capture of
// "whatever the server printed right after we sent the command."
const RESPONSE_QUIET_MS = 250;
const RESPONSE_HARD_TIMEOUT_MS = 1500;

class ProcessManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.child = null;
    this.state = 'offline';
    this.startedAt = null;
    this.history = [];
    this.historyLimit = 3000;
    // Commands are serialized so two concurrent sendCommand() calls can't
    // both listen for output at once and steal each other's response lines.
    this._commandQueue = Promise.resolve();
    this._restartPending = false;
  }

  _setState(state) {
    if (!VALID_STATES.includes(state)) throw new Error('Invalid state: ' + state);
    this.state = state;
    this.emit('state', state);
  }

  pushLog(text, level, time) {
    const entry = { text, level: level || 'INFO', time: time || new Date().toISOString() };
    this.history.push(entry);
    if (this.history.length > this.historyLimit) this.history.shift();
    this.emit('log', entry);
    return entry;
  }

  isRunning() {
    return this.child !== null;
  }

  start() {
    if (this.state !== 'offline') throw new Error('Server is already ' + this.state);
    const { directory, javaBin, javaArgs, jarFile, extraArgs } = this.config.server;
    const args = [...(javaArgs || []), '-jar', jarFile, ...(extraArgs || [])];

    this.pushLog(`Launching: ${javaBin} ${args.join(' ')}  (cwd: ${directory})`, 'INFO');
    this._setState('starting');

    let child;
    try {
      // stdin must be a pipe (not 'inherit') so we can write commands to it.
      child = spawn(javaBin, args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.pushLog(`Failed to spawn process: ${err.message}`, 'ERROR');
      this._setState('offline');
      throw err;
    }
    this.child = child;

    let outBuf = '';
    let errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      outBuf += chunk;
      const lines = outBuf.split('\n');
      outBuf = lines.pop();
      for (const line of lines) this._handleLine(line);
    });
    child.stderr.on('data', (chunk) => {
      errBuf += chunk;
      const lines = errBuf.split('\n');
      errBuf = lines.pop();
      for (const line of lines) this.pushLog(line, 'ERROR');
    });

    child.on('exit', (code, signal) => {
      this.pushLog(`Process exited (code=${code}, signal=${signal || 'none'})`, code === 0 ? 'INFO' : 'ERROR');
      this.child = null;
      this.startedAt = null;
      const restart = this._restartPending;
      this._restartPending = false;
      this._setState('offline');
      if (restart) setTimeout(() => { try { this.start(); } catch (e) { this.pushLog('Auto-restart failed: ' + e.message, 'ERROR'); } }, 1500);
    });

    child.on('error', (err) => {
      this.pushLog(`Process error: ${err.message}`, 'ERROR');
    });
  }

  _handleLine(line) {
    if (line.length === 0) return;
    const m = line.match(LOG_RE);
    if (m) {
      this.pushLog(line.slice(m[0].length), m[2]);
    } else {
      this.pushLog(line, 'INFO');
    }

    // Strip ANSI before testing for the startup marker — in principle a
    // color reset could land between "Done" and "(", however unlikely.
    if (this.state === 'starting' && DONE_RE.test(line.replace(ANSI_STRIP_RE, ''))) {
      this.startedAt = Date.now();
      this._setState('online');
    }
  }

  /**
   * Write a command to the server's stdin and capture whatever the console
   * prints in response over a short window. Commands are serialized through
   * this._commandQueue so overlapping calls don't cross-contaminate each
   * other's captured output.
   */
  sendCommand(cmd, { logAsUser = true } = {}) {
    const run = () => this._sendCommandNow(cmd, logAsUser);
    const result = this._commandQueue.then(run, run);
    // Keep the queue alive even if this command's promise rejects, so the
    // next queued command still runs.
    this._commandQueue = result.catch(() => {});
    return result;
  }

  _sendCommandNow(cmd, logAsUser) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error('No running process to send commands to — is the server online?'));
    }
    if (logAsUser) this.pushLog('> ' + cmd, 'CMD');

    const captured = [];
    return new Promise((resolve, reject) => {
      let quietTimer = null;
      let hardTimer = null;

      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        this.removeListener('log', onLog);
        resolve(captured.join('\n'));
      };
      const onLog = (entry) => {
        if (entry.level === 'CMD') return; // don't capture our own echoed command
        captured.push(entry.text);
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
      };

      this.on('log', onLog);
      quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
      hardTimer = setTimeout(finish, RESPONSE_HARD_TIMEOUT_MS);

      try {
        this.child.stdin.write(cmd + '\n');
      } catch (err) {
        this.removeListener('log', onLog);
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        reject(err);
      }
    });
  }

  /** Paper/vanilla stop with "stop"; Velocity stops with "shutdown". */
  _stopCommand() {
    return this.config.server.type === 'velocity' ? 'shutdown' : 'stop';
  }

  async stop() {
    if (this.state !== 'online') throw new Error('Server is not online');
    this._setState('stopping');
    const cmd = this._stopCommand();
    try {
      await this.sendCommand(cmd, { logAsUser: false });
      this.pushLog('> ' + cmd, 'CMD');
    } catch (err) {
      this.pushLog(`Sending "${cmd}" failed (` + err.message + '), sending SIGTERM', 'WARN');
      if (this.child) this.child.kill('SIGTERM');
    }
  }

  async restart() {
    if (this.state !== 'online') throw new Error('Server is not online');
    this._restartPending = true;
    this._setState('restarting');
    const cmd = this._stopCommand();
    try {
      await this.sendCommand(cmd, { logAsUser: false });
      this.pushLog(`> ${cmd} (restart)`, 'CMD');
    } catch (err) {
      this.pushLog(`Sending "${cmd}" failed (` + err.message + '), sending SIGTERM', 'WARN');
      if (this.child) this.child.kill('SIGTERM');
    }
  }

  kill() {
    if (!this.child) throw new Error('No running process to kill');
    this.pushLog('Force-killing process (SIGKILL)', 'WARN');
    this.child.kill('SIGKILL');
  }

  getUptimeMs() {
    return this.state === 'online' && this.startedAt ? Date.now() - this.startedAt : 0;
  }

  getPid() {
    return this.child ? this.child.pid : null;
  }
}

module.exports = ProcessManager;
