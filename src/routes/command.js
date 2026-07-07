'use strict';
const express = require('express');

module.exports = function commandRoutes(pm, statsSampler) {
  const router = express.Router();

  router.post('/command', async (req, res) => {
    const cmd = (req.body && req.body.command || '').trim();
    if (!cmd) return res.status(400).json({ error: 'Missing command' });
    try {
      const response = await pm.sendCommand(cmd);
      res.json({ ok: true, response: response || '' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/stats', async (req, res) => {
    try {
      const stats = await statsSampler.sample();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
