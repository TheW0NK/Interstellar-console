'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { EventEmitter } = require('events');

const MAX_ENTRIES = 500;

class FailedLoginStore extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) this._write([]);
  }

  _read() {
    try {
      const doc = yaml.load(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(doc)) return doc;
      if (doc && Array.isArray(doc.entries)) return doc.entries;
      return [];
    } catch (err) {
      return [];
    }
  }

  _write(entries) {
    const header =
      '# =============================================================================\n' +
      '# Vexium Panel — failed login attempts (auto-generated; oldest first, capped at ' + MAX_ENTRIES + ')\n' +
      '# Contains IP addresses and user agents of failed sign-in attempts.\n' +
      '# =============================================================================\n\n';
    fs.writeFileSync(this.filePath, header + yaml.dump(entries, { lineWidth: -1 }), 'utf8');
  }

  add({ username, ip, userAgent, reason }) {
    const entries = this._read();
    const entry = {
      id: 'fail_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: new Date().toISOString(),
      username: username || '',
      ip: ip || 'unknown',
      userAgent: userAgent || '',
      reason: reason || 'bad-credentials',
    };
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    this._write(entries);
    this.emit('add', entry);
    return entry;
  }

  list(limit = 100) {
    return this._read().slice(-limit).reverse();
  }

  countRecent(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this._read().filter((e) => new Date(e.time).getTime() >= cutoff).length;
  }
}

module.exports = FailedLoginStore;
