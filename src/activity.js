'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { EventEmitter } = require('events');

const MAX_ENTRIES = 200;

/**
 * Append-only recent-activity feed, stored as YAML so it's easy to read or
 * hand-edit on disk. Emits 'add' whenever a new entry is written so the
 * server can push it to connected dashboards over the websocket.
 */
class ActivityLog extends EventEmitter {
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
      '# Vexium Panel — recent activity (auto-generated; oldest first, capped at ' + MAX_ENTRIES + ')\n' +
      '# =============================================================================\n\n';
    fs.writeFileSync(this.filePath, header + yaml.dump(entries, { lineWidth: -1 }), 'utf8');
  }

  /**
   * @param {string} type    short category, e.g. 'auth', 'power', 'backup', 'plugin', 'player', 'admin', 'config', 'schedule'
   * @param {string} message human-readable description, e.g. "adrian restarted the server"
   * @param {string|null} user the acting username, if any (null for system/scheduled actions)
   */
  add(type, message, user = null) {
    const entries = this._read();
    const entry = {
      id: 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: new Date().toISOString(),
      type,
      message,
      user,
    };
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    this._write(entries);
    this.emit('add', entry);
    return entry;
  }

  list(limit = 30) {
    return this._read().slice(-limit).reverse();
  }
}

module.exports = ActivityLog;
