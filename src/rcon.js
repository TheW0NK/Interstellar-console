'use strict';
const net = require('net');

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0;

/**
 * Minimal Source RCON protocol client (used by Minecraft's RCON).
 * Handles single-packet request/response. Note: very large responses
 * (e.g. `/plugins` on a server with 100+ plugins) can span multiple
 * packets upstream — this client does not attempt fragment reassembly,
 * which matches vanilla/Paper RCON behavior for typical commands.
 */
class RconClient {
  constructor(host, port, password) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.reqId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  connect(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket = net.createConnection(this.port, this.host);
      this.socket.setTimeout(timeoutMs);

      this.socket.once('connect', async () => {
        this.connected = true;
        try {
          await this._authenticate();
          if (!settled) { settled = true; resolve(); }
        } catch (err) {
          if (!settled) { settled = true; reject(err); }
        }
      });
      this.socket.once('timeout', () => {
        if (!settled) { settled = true; reject(new Error('RCON connection timed out')); }
        this.socket.destroy();
      });
      this.socket.once('error', (err) => {
        this.connected = false;
        if (!settled) { settled = true; reject(err); }
      });
      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        for (const { reject: rej } of this.pending.values()) rej(new Error('RCON connection closed'));
        this.pending.clear();
      });
    });
  }

  _authenticate() {
    return this._send(TYPE_AUTH, this.password).then((res) => {
      if (res.id === -1) throw new Error('RCON authentication failed (bad password)');
      this.authenticated = true;
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < len + 4) break;
      const packet = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      if (packet.length < 8) continue;
      const id = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const payload = packet.subarray(8, Math.max(8, packet.length - 2)).toString('utf8');
      const pending = this.pending.get(id);
      if (pending) {
        pending.resolve({ id, type, payload });
        this.pending.delete(id);
      }
    }
  }

  _send(type, payload) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) return reject(new Error('RCON not connected'));
      const id = this.reqId++;
      const payloadBuf = Buffer.from(payload, 'utf8');
      const bodyLen = 4 + 4 + payloadBuf.length + 2;
      const buf = Buffer.alloc(4 + bodyLen);
      buf.writeInt32LE(bodyLen, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      payloadBuf.copy(buf, 12);
      buf.writeInt8(0, 12 + payloadBuf.length);
      buf.writeInt8(0, 13 + payloadBuf.length);

      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('RCON request timed out'));
        }
      }, 5000);

      this.pending.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.socket.write(buf);
    });
  }

  command(cmd) {
    if (!this.authenticated) return Promise.reject(new Error('RCON not authenticated'));
    return this._send(TYPE_COMMAND, cmd).then((r) => r.payload);
  }

  close() {
    if (this.socket) this.socket.end();
    this.connected = false;
    this.authenticated = false;
  }
}

module.exports = RconClient;
