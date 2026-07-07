'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function rankFromOpLevel(level) {
  if (level >= 4) return 'owner';
  if (level === 3) return 'admin';
  if (level >= 1) return 'moderator';
  return 'member';
}

async function parseOnlineNames(pm) {
  if (pm.state !== 'online') return [];
  try {
    const resp = await pm.sendCommand('list', { logAsUser: false });
    const idx = resp.indexOf(':');
    if (idx === -1) return [];
    return resp.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    return [];
  }
}

module.exports = function playerRoutes(config, pm, activityLog) {
  const router = express.Router();
  const dir = config.server.directory;
  const isVelocity = config.server.type === 'velocity';

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  function requirePaper(res) {
    res.status(400).json({ error: 'Not available on Velocity — player ranks, whitelist, and bans live on your backend Paper servers, not the proxy.' });
    return true;
  }

  router.get('/players', async (req, res) => {
    if (isVelocity) {
      // Velocity has no ops.json/whitelist.json/banned-players.json of its
      // own (those belong to the backend Paper servers), and its console
      // command surface for player management isn't something we're
      // confident enough about to reimplement here. Rather than guess at
      // command syntax that might silently do the wrong thing, we just
      // show whatever the proxy's own player-list command prints.
      if (pm.state !== 'online') return res.json({ type: 'velocity', raw: null });
      try {
        const raw = await pm.sendCommand('glist all', { logAsUser: false });
        return res.json({ type: 'velocity', raw });
      } catch (err) {
        return res.json({ type: 'velocity', raw: null, error: err.message });
      }
    }

    try {
      const online = await parseOnlineNames(pm);
      const ops = readJsonSafe(path.join(dir, 'ops.json'), []);
      const whitelist = readJsonSafe(path.join(dir, 'whitelist.json'), []);
      const banned = readJsonSafe(path.join(dir, 'banned-players.json'), []);
      const usercache = readJsonSafe(path.join(dir, 'usercache.json'), []);

      const byName = new Map();
      usercache.forEach((u) => byName.set(u.name, { name: u.name, lastSeen: u.expiresOn || null }));
      whitelist.forEach((u) => { if (!byName.has(u.name)) byName.set(u.name, { name: u.name }); });
      ops.forEach((u) => { if (!byName.has(u.name)) byName.set(u.name, { name: u.name }); });
      online.forEach((name) => { if (!byName.has(name)) byName.set(name, { name }); });

      const bannedNames = new Set(banned.map((b) => b.name));
      const opMap = new Map(ops.map((o) => [o.name, o.level]));
      const whitelistNames = new Set(whitelist.map((w) => w.name));

      const players = Array.from(byName.values()).map((p) => ({
        name: p.name,
        online: online.includes(p.name),
        rank: opMap.has(p.name) ? rankFromOpLevel(opMap.get(p.name)) : 'member',
        whitelisted: whitelistNames.has(p.name),
        banned: bannedNames.has(p.name),
        lastSeen: p.lastSeen || null,
        playtimeHours: null,
        ping: null,
      }));

      players.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
      res.json({ type: 'paper', players });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/players/:name/kick', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      const reason = req.body && req.body.reason ? ' ' + req.body.reason : '';
      await pm.sendCommand(`kick ${req.params.name}${reason}`);
      activityLog.add('player', `${actor(req)} kicked ${req.params.name}`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/players/:name/ban', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      const reason = req.body && req.body.reason ? ' ' + req.body.reason : '';
      await pm.sendCommand(`ban ${req.params.name}${reason}`);
      activityLog.add('player', `${actor(req)} banned ${req.params.name}`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/players/:name/unban', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      await pm.sendCommand(`pardon ${req.params.name}`);
      activityLog.add('player', `${actor(req)} unbanned ${req.params.name}`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/players/:name/op', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      await pm.sendCommand(`op ${req.params.name}`);
      activityLog.add('player', `${actor(req)} opped ${req.params.name}`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/players/:name/deop', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      await pm.sendCommand(`deop ${req.params.name}`);
      activityLog.add('player', `${actor(req)} de-opped ${req.params.name}`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/players/:name/whitelist', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      const add = req.body ? req.body.add !== false : true;
      await pm.sendCommand(`whitelist ${add ? 'add' : 'remove'} ${req.params.name}`);
      activityLog.add('player', `${actor(req)} ${add ? 'whitelisted' : 'un-whitelisted'} ${req.params.name}`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/players/:name/message', async (req, res) => {
    if (isVelocity) return requirePaper(res);
    try {
      const msg = (req.body && req.body.message || '').trim();
      if (!msg) throw new Error('Empty message');
      await pm.sendCommand(`tell ${req.params.name} ${msg}`);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
};
