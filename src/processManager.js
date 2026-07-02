'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const RconClient = require('./rcon');

const DONE_RE = /Done \(/;
const LOG_RE = /^\[(\d{2}:\d{2}:\d{2})\s+(INFO|WARN|ERROR|DEBUG)\]:\s?(.*)$/;

const VALID_STATES = ['offline', 'starting', 'online', 'stopping', 'restarting'];

class ProcessManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.child = null;
    this.state = 'offline';
    this.startedAt = null;
    this.history = [];
    this.historyLimit = 3000;
    this.rcon = null;
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
      child = spawn(javaBin, args, { cwd: directory });
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
      if (this.rcon) { try { this.rcon.close(); } catch (e) {} this.rcon = null; }
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
    if (m) this.pushLog(m[3], m[2]);
    else this.pushLog(line, 'INFO');

    if (this.state === 'starting' && DONE_RE.test(line)) {
      this.startedAt = Date.now();
      this._setState('online');
      this._connectRcon().catch(() => {});
    }
  }

  async _connectRcon(retries = 6) {
    const { host, port, password } = this.config.rcon;
    for (let i = 0; i < retries; i++) {
      try {
        const client = new RconClient(host, port, password);
        await client.connect();
        this.rcon = client;
        this.pushLog('RCON connected', 'INFO');
        this.emit('rcon-ready');
        client.socket.on('close', () => { if (this.rcon === client) this.rcon = null; });
        return;
      } catch (err) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    this.pushLog('Could not establish RCON connection after retries — is rcon enabled in server.properties?', 'ERROR');
  }

  async sendCommand(cmd, { logAsUser = true } = {}) {
    if (!this.rcon || !this.rcon.authenticated) throw new Error('RCON is not connected — the server may still be starting.');
    if (logAsUser) this.pushLog('> ' + cmd, 'CMD');
    const response = await this.rcon.command(cmd);
    if (logAsUser && response) this.pushLog(response, 'INFO');
    return response;
  }

  async stop() {
    if (this.state !== 'online') throw new Error('Server is not online');
    this._setState('stopping');
    try {
      await this.sendCommand('stop', { logAsUser: false });
      this.pushLog('> stop', 'CMD');
    } catch (err) {
      this.pushLog('RCON stop failed (' + err.message + '), sending SIGTERM', 'WARN');
      if (this.child) this.child.kill('SIGTERM');
    }
  }

  async restart() {
    if (this.state !== 'online') throw new Error('Server is not online');
    this._restartPending = true;
    this._setState('restarting');
    try {
      await this.sendCommand('stop', { logAsUser: false });
      this.pushLog('> stop (restart)', 'CMD');
    } catch (err) {
      this.pushLog('RCON stop failed (' + err.message + '), sending SIGTERM', 'WARN');
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
