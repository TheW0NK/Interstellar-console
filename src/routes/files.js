'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');

function safeResolve(root, relPath) {
  const rel = (relPath || '').replace(/^\/+/, '');
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path escapes server directory');
  }
  return resolved;
}

module.exports = function filesRoutes(config) {
  const router = express.Router();
  const root = config.server.directory;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

  router.get('/files', async (req, res) => {
    try {
      const target = safeResolve(root, req.query.path || '');
      const names = await fsp.readdir(target, { withFileTypes: true });
      const items = await Promise.all(names.map(async (d) => {
        const full = path.join(target, d.name);
        let st;
        try { st = await fsp.stat(full); } catch (e) { return null; }
        return {
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size: d.isDirectory() ? null : st.size,
          mtime: st.mtime.toISOString(),
        };
      }));
      const filtered = items.filter(Boolean).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json(filtered);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/files/content', async (req, res) => {
    try {
      const target = safeResolve(root, req.query.path || '');
      const st = await fsp.stat(target);
      if (st.isDirectory()) throw new Error('Cannot open a directory as a file');
      if (st.size > 5 * 1024 * 1024) throw new Error('File too large to edit in-browser (>5MB)');
      const content = await fsp.readFile(target, 'utf8');
      res.json({ content });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/files/content', express.json({ limit: '10mb' }), async (req, res) => {
    try {
      const target = safeResolve(root, req.body.path || '');
      await fsp.writeFile(target, req.body.content ?? '', 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/files/mkdir', async (req, res) => {
    try {
      const target = safeResolve(root, req.body.path || '');
      await fsp.mkdir(target, { recursive: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/files', async (req, res) => {
    try {
      const target = safeResolve(root, req.body.path || '');
      if (target === root) throw new Error('Refusing to delete the server root directory');
      await fsp.rm(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) throw new Error('No file provided');
      const target = safeResolve(root, path.join(req.body.path || '', req.file.originalname));
      await fsp.writeFile(target, req.file.buffer);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
