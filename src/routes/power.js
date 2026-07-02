'use strict';
const express = require('express');

module.exports = function powerRoutes(pm, activityLog) {
  const router = express.Router();

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/status', (req, res) => {
    res.json({ state: pm.state, uptimeMs: pm.getUptimeMs(), pid: pm.getPid() });
  });

  router.post('/power/start', (req, res) => {
    try {
      pm.start();
      activityLog.add('power', `${actor(req)} started the server`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/power/restart', async (req, res) => {
    try {
      await pm.restart();
      activityLog.add('power', `${actor(req)} restarted the server`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/power/stop', async (req, res) => {
    try {
      await pm.stop();
      activityLog.add('power', `${actor(req)} stopped the server`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/power/kill', (req, res) => {
    try {
      pm.kill();
      activityLog.add('power', `${actor(req)} force-killed the server process`, actor(req));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
};
