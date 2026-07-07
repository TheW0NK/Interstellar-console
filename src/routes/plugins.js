'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const HANGAR_API = 'https://hangar.papermc.io/api/v1';

function safeJarName(name) {
  if (!name || /[\/\\]/.test(name) || name.includes('..') || !name.endsWith('.jar')) {
    throw new Error('Invalid plugin filename');
  }
  return name;
}

module.exports = function pluginRoutes(config, pm, activityLog) {
  const router = express.Router();
  const pluginsDir = path.join(config.server.directory, 'plugins');
  const hangarPlatform = config.server.type === 'velocity' ? 'VELOCITY' : 'PAPER';

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/plugins/search', async (req, res) => {
    try {
      const q = req.query.q || '';
      const url = `${HANGAR_API}/projects?limit=25&offset=0&sort=-stars&platform=${hangarPlatform}${q ? '&query=' + encodeURIComponent(q) : ''}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('Hangar API returned ' + r.status);
      const data = await r.json();
      const results = (data.result || []).map((p) => ({
        slug: p.name,
        namespace: p.namespace ? `${p.namespace.owner}/${p.namespace.slug}` : p.name,
        description: p.description,
        category: p.category,
        stars: p.stats ? p.stats.stars : 0,
        downloads: p.stats ? p.stats.downloads : 0,
        icon: p.avatarUrl || null,
      }));
      res.json(results);
    } catch (err) {
      res.status(502).json({ error: 'Could not reach Hangar: ' + err.message });
    }
  });

  router.post('/plugins/install', express.json(), async (req, res) => {
    try {
      const { owner, slug } = req.body || {};
      if (!owner || !slug) throw new Error('owner and slug are required');

      const versionsUrl = `${HANGAR_API}/projects/${owner}/${slug}/versions?limit=1`;
      const vr = await fetch(versionsUrl);
      if (!vr.ok) throw new Error('Could not fetch versions from Hangar (' + vr.status + ')');
      const vdata = await vr.json();
      const latest = vdata.result && vdata.result[0];
      if (!latest) throw new Error('No published versions found for this plugin');

      const download = latest.downloads && latest.downloads[hangarPlatform];
      if (!download || !download.downloadUrl) throw new Error(`No ${hangarPlatform}-compatible download found for this plugin`);

      const jarRes = await fetch(download.downloadUrl);
      if (!jarRes.ok) throw new Error('Download failed (' + jarRes.status + ')');
      const buf = Buffer.from(await jarRes.arrayBuffer());

      await fsp.mkdir(pluginsDir, { recursive: true });
      const fileName = `${slug}-${latest.name}.jar`.replace(/[^a-zA-Z0-9._-]/g, '-');
      await fsp.writeFile(path.join(pluginsDir, fileName), buf);

      pm.pushLog(`Installed plugin: ${fileName} (restart or /reload required)`, 'INFO');
      activityLog.add('plugin', `${actor(req)} installed plugin "${fileName}"`, actor(req));
      res.json({ ok: true, fileName });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/plugins/installed', async (req, res) => {
    try {
      await fsp.mkdir(pluginsDir, { recursive: true });
      const names = await fsp.readdir(pluginsDir);
      const jars = names.filter((n) => n.endsWith('.jar'));
      const items = await Promise.all(jars.map(async (n) => {
        const st = await fsp.stat(path.join(pluginsDir, n));
        return { fileName: n, sizeBytes: st.size, installedAt: st.mtime.toISOString() };
      }));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/plugins/installed/:fileName', async (req, res) => {
    try {
      const fileName = safeJarName(req.params.fileName);
      await fsp.unlink(path.join(pluginsDir, fileName));
      pm.pushLog(`Removed plugin: ${fileName} (restart required)`, 'WARN');
      activityLog.add('plugin', `${actor(req)} removed plugin "${fileName}"`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
