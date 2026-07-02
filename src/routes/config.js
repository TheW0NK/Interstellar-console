'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

// Keys the "MC Configuration" tab exposes, mapped to server.properties keys.
const FIELD_MAP = {
  motd: 'motd',
  maxPlayers: 'max-players',
  difficulty: 'difficulty',
  gamemode: 'gamemode',
  viewDistance: 'view-distance',
  simulationDistance: 'simulation-distance',
  pvp: 'pvp',
  onlineMode: 'online-mode',
  whitelist: 'white-list',
  allowFlight: 'allow-flight',
  commandBlocks: 'enable-command-block',
};

function parseProperties(text) {
  const map = {};
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  });
  return map;
}

function writeProperties(originalText, updates) {
  const lines = originalText.split('\n');
  const seen = new Set();
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${val}`);
  }
  return out.join('\n');
}

module.exports = function configRoutes(config, activityLog) {
  const router = express.Router();
  const propsPath = path.join(config.server.directory, 'server.properties');

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/config', (req, res) => {
    try {
      const text = fs.readFileSync(propsPath, 'utf8');
      const raw = parseProperties(text);
      const values = {};
      for (const [field, key] of Object.entries(FIELD_MAP)) {
        values[field] = raw[key] !== undefined ? raw[key] : null;
      }
      res.json(values);
    } catch (err) {
      res.status(400).json({ error: 'Could not read server.properties: ' + err.message });
    }
  });

  router.put('/config', express.json(), (req, res) => {
    try {
      const text = fs.readFileSync(propsPath, 'utf8');
      const updates = {};
      for (const [field, key] of Object.entries(FIELD_MAP)) {
        if (Object.prototype.hasOwnProperty.call(req.body, field) && req.body[field] !== null) {
          updates[key] = req.body[field];
        }
      }
      const newText = writeProperties(text, updates);
      fs.writeFileSync(propsPath, newText, 'utf8');
      activityLog.add('config', `${actor(req)} updated server.properties`, actor(req));
      res.json({ ok: true, note: 'Most values need a server restart (or /reload) to take effect.' });
    } catch (err) {
      res.status(400).json({ error: 'Could not write server.properties: ' + err.message });
    }
  });

  return router;
};
