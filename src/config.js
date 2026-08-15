'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = process.env.VEXIUM_CONFIG || path.join(__dirname, '..', 'config', 'config.yml');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = yaml.load(raw);

  // Resolve relative paths against the project root so it doesn't matter
  // where the process is launched from.
  const root = path.join(__dirname, '..');
  cfg.servers.file = path.resolve(root, cfg.servers.file);
  cfg.activity.file = path.resolve(root, cfg.activity.file);
  cfg.failedLogins.file = path.resolve(root, cfg.failedLogins.file);
  cfg.avatars.directory = path.resolve(root, cfg.avatars.directory);
  cfg.branding.file = path.resolve(root, cfg.branding.file);
  cfg.users.file = path.resolve(root, cfg.users.file);
  cfg.gus.file = path.resolve(root, cfg.gus.file);
  cfg.gus.usersFile = path.resolve(root, cfg.gus.usersFile);
  // Per-server backups/schedules live under these roots, namespaced by
  // server id — see src/servers.js.
  cfg.backupsRoot = path.resolve(root, './data/backups');
  cfg.schedulesRoot = path.resolve(root, './data/schedules');

  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
