'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const ProcessManager = require('./processManager');
const StatsSampler = require('./stats');

const ID_RE = /^[a-z0-9_-]+$/i;

/**
 * Builds one "server config" object per entry in servers.yml, shaped
 * exactly like the old single-server config object (.server.*,
 * .backups.*, .sftp.*) so every existing route factory (files.js,
 * backups.js, schedules.js, players.js, plugins.js, config.js) works
 * completely unmodified — it just gets instantiated once per server
 * instead of once globally.
 */
class ServerRegistry {
  constructor(panelConfig) {
    this.panelConfig = panelConfig;
    this.instances = new Map(); // id -> { serverConfig, pm, statsSampler, meta }
    this._load();
  }

  _load() {
    const raw = fs.readFileSync(this.panelConfig.servers.file, 'utf8');
    const doc = yaml.load(raw) || {};
    const list = Array.isArray(doc.servers) ? doc.servers : [];
    if (list.length === 0) throw new Error('config/servers.yml has no servers defined — add at least one.');

    const seen = new Set();
    for (const entry of list) {
      if (!entry.id || !ID_RE.test(entry.id)) {
        throw new Error(`Invalid server id "${entry.id}" — use only letters, numbers, hyphens, underscores.`);
      }
      if (seen.has(entry.id)) throw new Error(`Duplicate server id "${entry.id}" in servers.yml`);
      seen.add(entry.id);

      const serverConfig = {
        server: {
          type: entry.type || 'paper',
          directory: path.resolve(entry.directory || '.'),
          jarFile: entry.jarFile || 'paper.jar',
          javaBin: entry.javaBin || 'java',
          javaArgs: entry.javaArgs || [],
          extraArgs: entry.extraArgs || [],
          bridgeStatsFile: entry.bridgeStatsFile || 'plugins/VexiumBridge/stats.json',
        },
        backups: {
          directory: path.join(this.panelConfig.backupsRoot, entry.id),
          include: (entry.backups && entry.backups.include) || ['world', 'plugins'],
        },
        sftp: entry.sftp || { host: '', port: 22, username: '' },
        schedules: {
          file: path.join(this.panelConfig.schedulesRoot, `${entry.id}.json`),
        },
      };
      fs.mkdirSync(serverConfig.backups.directory, { recursive: true });
      fs.mkdirSync(this.panelConfig.schedulesRoot, { recursive: true });

      const pm = new ProcessManager(serverConfig);
      const statsSampler = new StatsSampler(serverConfig, pm);

      this.instances.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        type: serverConfig.server.type,
        serverConfig,
        pm,
        statsSampler,
      });
    }
  }

  list() {
    return Array.from(this.instances.values()).map((i) => ({
      id: i.id, name: i.name, type: i.type, state: i.pm.state,
    }));
  }

  get(id) {
    return this.instances.get(id);
  }

  has(id) {
    return this.instances.has(id);
  }

  isSingleServer() {
    return this.instances.size === 1;
  }

  firstId() {
    return this.instances.keys().next().value;
  }

  forEach(fn) {
    this.instances.forEach(fn);
  }
}

module.exports = ServerRegistry;
