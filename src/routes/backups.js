'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

function safeName(name) {
  if (!name || /[\/\\]/.test(name) || name.includes('..')) throw new Error('Invalid backup name');
  return name;
}

module.exports = function backupRoutes(config, pm, activityLog) {
  const router = express.Router();
  const backupsDir = config.backups.directory;
  const serverDir = config.server.directory;
  const include = config.backups.include;

  fs.mkdirSync(backupsDir, { recursive: true });

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/backups', async (req, res) => {
    try {
      const names = await fsp.readdir(backupsDir);
      const items = await Promise.all(
        names.filter((n) => n.endsWith('.tar.gz')).map(async (n) => {
          const st = await fsp.stat(path.join(backupsDir, n));
          return { name: n, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
        })
      );
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/backups', express.json(), async (req, res) => {
    try {
      const label = (req.body && req.body.label ? String(req.body.label) : 'manual').replace(/[^a-z0-9_-]/gi, '-');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `${stamp}_${label}.tar.gz`;
      const existing = include.filter((p) => fs.existsSync(path.join(serverDir, p)));
      if (existing.length === 0) throw new Error('None of the configured backup paths exist in the server directory');
      await run('tar', ['-czf', path.join(backupsDir, name), ...existing], serverDir);
      pm.pushLog(`Backup created: ${name}`, 'INFO');
      activityLog.add('backup', `${actor(req)} created backup "${name}"`, actor(req));
      res.json({ ok: true, name });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/backups/:name', async (req, res) => {
    try {
      const name = safeName(req.params.name);
      await fsp.unlink(path.join(backupsDir, name));
      activityLog.add('backup', `${actor(req)} deleted backup "${name}"`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/backups/:name/restore', async (req, res) => {
    try {
      if (pm.state !== 'offline') throw new Error('Stop the server before restoring a backup');
      const name = safeName(req.params.name);
      const filePath = path.join(backupsDir, name);
      if (!fs.existsSync(filePath)) throw new Error('Backup not found');
      await run('tar', ['-xzf', filePath], serverDir);
      pm.pushLog(`Backup restored: ${name}`, 'WARN');
      activityLog.add('backup', `${actor(req)} restored backup "${name}"`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
