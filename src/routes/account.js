'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');

const ALLOWED_AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Self-service account routes, available to every authenticated user
 * regardless of role or auth source. Branches internally on
 * req.session.user.authSource ('gus' | 'local') since password/profile
 * changes for a GUS account have to go through GUS itself — this panel
 * never stores a GUS password. Avatars are local either way (GUS has no
 * concept of them), keyed by the STABLE identifier (uid for GUS accounts,
 * username for local ones) so a GUS-side username rename doesn't orphan
 * the file.
 */
module.exports = function accountRoutes(config, { userStore, gusUserStore, gusClient }, activityLog) {
  const router = express.Router();
  const avatarsDir = config.avatars.directory;
  fs.mkdirSync(avatarsDir, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_AVATAR_TYPES[file.mimetype]) return cb(new Error('Only PNG, JPEG, or WEBP images are allowed'));
      cb(null, true);
    },
  });

  function isGus(req) { return req.session.user.authSource === 'gus'; }
  function avatarKey(req) { return isGus(req) ? req.session.user.uid : req.session.user.username; }

  router.get('/account', (req, res) => {
    const profile = isGus(req) ? gusUserStore.findByUid(req.session.user.uid)
      : userStore.getProfile(req.session.user.username);
    if (!profile) return res.status(404).json({ error: 'Account not found' });
    res.json({ ...profile, passwordManagedByGus: isGus(req) });
  });

  router.put('/account', express.json(), async (req, res) => {
    try {
      const { fullName, description, theme } = req.body || {};
      if (isGus(req)) {
        const { body } = await gusClient.updateProfile(req.session.gusToken, { fullName, description, theme });
        if (body.status !== 'ok') throw new Error(body.error || 'Could not update profile via GUS');
        if (theme !== undefined) gusUserStore.updatePreferences(req.session.user.uid, { theme });
        return res.json({ ok: true, profile: body.user });
      }
      const updates = {};
      if (fullName !== undefined) updates.fullName = String(fullName).slice(0, 100);
      if (description !== undefined) updates.description = String(description).slice(0, 300);
      if (theme !== undefined && ['ember', 'ocean', 'forest', 'light'].includes(theme)) updates.theme = theme;
      const profile = userStore.update(req.session.user.username, updates);
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/account/password', express.json(), async (req, res) => {
    try {
      const { currentPassword, newPassword, confirmPassword } = req.body || {};
      if (isGus(req)) {
        const { body } = await gusClient.changePassword(req.session.gusToken, { currentPassword, newPassword, confirmPassword });
        if (body.status !== 'ok') throw new Error(body.error || 'Could not change password via GUS');
        gusUserStore.syncProfile(body.user); // clears the cached mustChangePassword immediately — don't wait for the next login/revalidation
        activityLog.add('account', `${req.session.user.username} changed their password (via GUS)`, req.session.user.username);
        return res.json({ ok: true });
      }
      const username = req.session.user.username;
      const user = userStore.findByUsername(username);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      if (user.cannotChangePassword) {
        return res.status(403).json({ error: 'This account is not permitted to change its own password. Ask an owner to reset it.' });
      }
      if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');
      if (newPassword !== confirmPassword) throw new Error('New password and confirmation do not match');
      const needsForced = user.mustChangePassword || userStore.isPasswordExpired(user);
      if (!needsForced) {
        if (!currentPassword || !userStore.verifyPassword(username, currentPassword)) {
          throw new Error('Current password is incorrect');
        }
      }
      userStore.resetPassword(username, newPassword, { clearMustChange: true });
      activityLog.add('account', `${username} changed their own password`, username);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/account/avatar', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      try {
        if (!req.file) throw new Error('No file provided');
        const key = avatarKey(req);
        const ext = ALLOWED_AVATAR_TYPES[req.file.mimetype];
        const existingExt = isGus(req) ? (gusUserStore.findByUid(key) || {}).avatarExt : (userStore.findByUsername(key) || {}).avatarExt;
        if (existingExt && existingExt !== ext) {
          await fsp.unlink(path.join(avatarsDir, `${key}.${existingExt}`)).catch(() => {});
        }
        await fsp.writeFile(path.join(avatarsDir, `${key}.${ext}`), req.file.buffer);
        if (isGus(req)) gusUserStore.updatePreferences(key, { avatarExt: ext });
        else userStore.update(key, { avatarExt: ext });
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  });

  /** Avatars are looked up by username in the URL for convenience (that's
   *  what's visible in the UI), resolved to the right storage key
   *  internally — GUS accounts store under uid, local under username. */
  router.get('/account/avatar/:username', (req, res) => {
    const gusEntry = gusUserStore.findByUsername(req.params.username);
    const localEntry = gusEntry ? null : userStore.findByUsername(req.params.username);
    const target = gusEntry || localEntry;
    if (!target || !target.avatarExt) return res.status(404).json({ error: 'No avatar set' });
    const key = gusEntry ? gusEntry.uid : target.username;
    const filePath = path.join(avatarsDir, `${key}.${target.avatarExt}`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No avatar set' });
    res.set('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  });

  router.delete('/account/avatar', async (req, res) => {
    try {
      const key = avatarKey(req);
      const existingExt = isGus(req) ? (gusUserStore.findByUid(key) || {}).avatarExt : (userStore.findByUsername(key) || {}).avatarExt;
      if (existingExt) {
        await fsp.unlink(path.join(avatarsDir, `${key}.${existingExt}`)).catch(() => {});
        if (isGus(req)) gusUserStore.updatePreferences(key, { avatarExt: null });
        else userStore.update(key, { avatarExt: null });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
