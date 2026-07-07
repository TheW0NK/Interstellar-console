'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { requireAuth } = require('../auth');

function readBranding(filePath) {
  try {
    const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
    return { serverName: (doc && doc.serverName) || 'Minecraft Server' };
  } catch (err) {
    return { serverName: 'Minecraft Server' };
  }
}

function writeBranding(filePath, branding) {
  const header =
    '# =============================================================================\n' +
    '# Vexium Panel — branding\n' +
    '# =============================================================================\n\n';
  fs.writeFileSync(filePath, header + yaml.dump(branding, { lineWidth: -1 }), 'utf8');
}

module.exports = function brandingRoutes(config, activityLog) {
  const router = express.Router();
  const brandingFile = config.branding.file;
  const iconPath = path.join(config.server.directory, 'server-icon.png');

  // Public: the login screen needs the name/icon before anyone is signed in.
  router.get('/branding', (req, res) => {
    const branding = readBranding(brandingFile);
    res.json({ serverName: branding.serverName, hasIcon: fs.existsSync(iconPath) });
  });

  router.get('/server-icon', (req, res) => {
    if (!fs.existsSync(iconPath)) return res.status(404).json({ error: 'No server-icon.png found' });
    res.set('Cache-Control', 'no-cache');
    res.sendFile(iconPath);
  });

  // Protected: renaming the server is a real change worth attributing.
  router.put('/branding', requireAuth, express.json(), (req, res) => {
    try {
      const serverName = (req.body && req.body.serverName || '').trim();
      if (!serverName) throw new Error('Server name cannot be empty');
      if (serverName.length > 64) throw new Error('Server name is too long (max 64 characters)');
      writeBranding(brandingFile, { serverName });
      const actor = req.session && req.session.user ? req.session.user.username : null;
      activityLog.add('config', `${actor} renamed the panel to "${serverName}"`, actor);
      res.json({ ok: true, serverName });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
