'use strict';
const express = require('express');

module.exports = function adminRoutes(userStore, activityLog) {
  const router = express.Router();

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/admins', (req, res) => {
    res.json(userStore.list());
  });

  router.post('/admins', express.json(), (req, res) => {
    try {
      const { username, password, role } = req.body || {};
      if (!username || !password || !role) throw new Error('username, password, and role are required');
      if (!['owner', 'admin', 'moderator'].includes(role)) throw new Error('Invalid role');
      const user = userStore.add({ username, password, role });
      activityLog.add('admin', `${actor(req)} added administrator "${username}" (${role})`, actor(req));
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/admins/:username', express.json(), (req, res) => {
    try {
      if (req.body.role) {
        userStore.setRole(req.params.username, req.body.role);
        activityLog.add('admin', `${actor(req)} changed ${req.params.username}'s role to ${req.body.role}`, actor(req));
      }
      if (req.body.password) {
        userStore.resetPassword(req.params.username, req.body.password);
        activityLog.add('admin', `${actor(req)} reset ${req.params.username}'s password`, actor(req));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/admins/:username', (req, res) => {
    try {
      if (req.session.user && req.session.user.username.toLowerCase() === req.params.username.toLowerCase()) {
        throw new Error('You cannot remove your own account while signed in');
      }
      userStore.remove(req.params.username);
      activityLog.add('admin', `${actor(req)} removed administrator "${req.params.username}"`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
