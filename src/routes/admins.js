'use strict';
const express = require('express');
const { VALID_ROLES } = require('../auth');

module.exports = function adminRoutes(userStore, activityLog) {
  const router = express.Router();

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }
  function isSelf(req, username) {
    return req.session.user && req.session.user.username.toLowerCase() === username.toLowerCase();
  }

  router.get('/admins', (req, res) => {
    res.json(userStore.list());
  });

  router.get('/admins/:username', (req, res) => {
    const profile = userStore.getProfile(req.params.username);
    if (!profile) return res.status(404).json({ error: 'No such user' });
    res.json(profile);
  });

  router.post('/admins', express.json(), (req, res) => {
    try {
      const { username, password, role, fullName, description } = req.body || {};
      if (!username || !password || !role) throw new Error('username, password, and role are required');
      if (password.length < 8) throw new Error('Password must be at least 8 characters');
      if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
      const user = userStore.add({ username, password, role, fullName, description });
      activityLog.add('admin', `${actor(req)} added administrator "${username}" (${role})`, actor(req));
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Full profile update — backs the "More" dialog. Handles username
   * rename, role change, password reset, and every account-option
   * checkbox in one call so the dialog can save everything at once.
   */
  router.patch('/admins/:username', express.json(), (req, res) => {
    try {
      const body = req.body || {};
      let currentUsername = req.params.username;
      const target = userStore.findByUsername(currentUsername);
      if (!target) throw new Error('No such user');

      if (body.role) {
        if (!VALID_ROLES.includes(body.role)) throw new Error('Invalid role');
        userStore.setRole(currentUsername, body.role);
        activityLog.add('admin', `${actor(req)} changed ${currentUsername}'s role to ${body.role}`, actor(req));
      }

      if (body.password) {
        if (body.password.length < 8) throw new Error('Password must be at least 8 characters');
        if (body.confirmPassword !== undefined && body.password !== body.confirmPassword) {
          throw new Error('Password and confirmation do not match');
        }
        userStore.resetPassword(currentUsername, body.password, { clearMustChange: false });
        activityLog.add('admin', `${actor(req)} reset ${currentUsername}'s password`, actor(req));
      }

      const profileUpdates = {};
      ['fullName', 'description', 'mustChangePassword', 'cannotChangePassword', 'passwordNeverExpires', 'passwordExpiresAt'].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(body, k)) profileUpdates[k] = body[k];
      });
      if (Object.prototype.hasOwnProperty.call(body, 'disabled')) {
        if (body.disabled === true && isSelf(req, currentUsername)) {
          throw new Error('You cannot disable your own account while signed in');
        }
        profileUpdates.disabled = body.disabled;
      }
      if (Object.keys(profileUpdates).length > 0) {
        userStore.update(currentUsername, profileUpdates);
      }

      if (body.newUsername && body.newUsername.trim() && body.newUsername.trim() !== currentUsername) {
        if (isSelf(req, currentUsername)) {
          throw new Error('Renaming your own account while signed in isn\'t supported yet — ask another owner.');
        }
        const renamed = userStore.rename(currentUsername, body.newUsername.trim());
        activityLog.add('admin', `${actor(req)} renamed "${currentUsername}" to "${renamed}"`, actor(req));
        currentUsername = renamed;
      }

      res.json({ ok: true, profile: userStore.getProfile(currentUsername) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/admins/:username/permissions', (req, res) => {
    const profile = userStore.getProfile(req.params.username);
    if (!profile) return res.status(404).json({ error: 'No such user' });
    res.json(profile.permissions || { extraTabs: [], powerActions: false });
  });

  router.put('/admins/:username/permissions', express.json(), (req, res) => {
    try {
      const { extraTabs, powerActions } = req.body || {};
      const perms = userStore.setPermissions(req.params.username, { extraTabs, powerActions });
      activityLog.add('admin', `${actor(req)} updated Fine Permissions for ${req.params.username}`, actor(req));
      res.json({ ok: true, permissions: perms });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/admins/:username', (req, res) => {
    try {
      if (isSelf(req, req.params.username)) {
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
