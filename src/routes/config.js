'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

/* ---------- server.properties (Paper/vanilla) — flat key=value ---------- */
function parsePropertiesOrdered(text) {
  const entries = [];
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    entries.push({ section: '', key, value, type: /^(true|false)$/.test(value) ? 'bool' : (/^-?\d+(\.\d+)?$/.test(value) ? 'number' : 'string') });
  });
  return entries;
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

/* ---------- velocity.toml — best-effort flat scalar editor ----------
 * Only simple "key = value" scalar assignments (string/number/bool) are
 * exposed and editable. Arrays and inline tables (e.g. the servers.try
 * list) are left alone entirely — those need the File Manager, since a
 * generic key=value editor can't safely round-trip TOML's richer types. */
function parseTomlOrdered(text) {
  const entries = [];
  let section = '';
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const sectionMatch = trimmed.match(/^\[([^\[\]]+)\]$/);
    if (sectionMatch) { section = sectionMatch[1]; return; }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) return;
    const key = kv[1];
    const rawValue = kv[2].trim();
    if (rawValue.startsWith('[') || rawValue.startsWith('{')) return; // array/inline table — skip
    let type, value;
    if (rawValue === 'true' || rawValue === 'false') { type = 'bool'; value = rawValue; }
    else if (/^-?\d+(\.\d+)?$/.test(rawValue)) { type = 'number'; value = rawValue; }
    else if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      type = 'string'; value = rawValue.slice(1, -1);
    } else { type = 'string'; value = rawValue; }
    entries.push({ section, key, value, type });
  });
  return entries;
}

function writeToml(originalText, updatesByFullKey) {
  let section = '';
  const lines = originalText.split('\n');
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const sectionMatch = trimmed.match(/^\[([^\[\]]+)\]$/);
    if (sectionMatch) { section = sectionMatch[1]; return line; }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) return line;
    const key = kv[1];
    const fullKey = section ? `${section}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(updatesByFullKey, fullKey)) return line;
    const { value, type } = updatesByFullKey[fullKey];
    const serialized = (type === 'bool' || type === 'number') ? String(value) : `"${String(value).replace(/"/g, '\\"')}"`;
    const indent = (line.match(/^(\s*)/) || ['', ''])[1];
    return `${indent}${key} = ${serialized}`;
  });
  return out.join('\n');
}

module.exports = function configRoutes(config, activityLog) {
  const router = express.Router();
  const isVelocity = config.server.type === 'velocity';
  const configFileName = isVelocity ? 'velocity.toml' : 'server.properties';
  const configPath = path.join(config.server.directory, configFileName);

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/config', (req, res) => {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      const entries = isVelocity ? parseTomlOrdered(text) : parsePropertiesOrdered(text);
      res.json({ type: config.server.type, fileName: configFileName, entries });
    } catch (err) {
      res.status(400).json({ error: `Could not read ${configFileName}: ` + err.message });
    }
  });

  router.put('/config', express.json(), (req, res) => {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      const rawUpdates = (req.body && req.body.updates) || {};
      let newText;

      if (isVelocity) {
        const entries = parseTomlOrdered(text);
        const updatesByFullKey = {};
        for (const e of entries) {
          const fullKey = e.section ? `${e.section}.${e.key}` : e.key;
          if (Object.prototype.hasOwnProperty.call(rawUpdates, fullKey)) {
            updatesByFullKey[fullKey] = { value: rawUpdates[fullKey], type: e.type };
          }
        }
        newText = writeToml(text, updatesByFullKey);
      } else {
        newText = writeProperties(text, rawUpdates);
      }

      fs.writeFileSync(configPath, newText, 'utf8');
      const actorName = actor(req);
      activityLog.add('config', `${actorName} updated ${configFileName}`, actorName);
      const note = isVelocity
        ? 'Most values need a proxy restart to take effect.'
        : 'Most values need a restart (or /reload on Paper) to take effect.';
      res.json({ ok: true, note });
    } catch (err) {
      res.status(400).json({ error: `Could not write ${configFileName}: ` + err.message });
    }
  });

  return router;
};
