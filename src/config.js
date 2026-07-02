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
  cfg.backups.directory = path.resolve(root, cfg.backups.directory);
  cfg.schedules.file = path.resolve(root, cfg.schedules.file);
  cfg.activity.file = path.resolve(root, cfg.activity.file);
  cfg.branding.file = path.resolve(root, cfg.branding.file);
  cfg.users.file = path.resolve(root, cfg.users.file);
  cfg.server.directory = path.resolve(cfg.server.directory);

  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
