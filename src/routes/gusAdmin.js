'use strict';
const express = require('express');

const DISABLE_CONFIRMATION_PHRASE = 'DISABLE GUS';

/** Verifies the CURRENT session owner's own password again, regardless of
 *  which system they actually authenticated with — required before the
 *  disable-GUS action can go through, so it can't be done from an
 *  unattended/hijacked browser tab alone. */
async function reverifyCurrentUser(req, password, { userStore, gusClient }) {
  const sessionUser = req.session.user;
  if (!password) return false;
  if (sessionUser.authSource === 'gus') {
    try {
      const { body } = await gusClient.login(sessionUser.username, password);
      return body.status === 'good' || body.status === 'good_change_pw';
    } catch (err) {
      return false;
    }
  }
  return userStore.verifyPassword(sessionUser.username, password);
}

module.exports = function gusAdminRoutes({ gusUserStore, gusSettingsStore, gusClient, userStore, activityLog }) {
  const router = express.Router();

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  /* ---------- Fine Permissions roster ---------- */
  router.get('/gus/roster', (req, res) => {
    res.json(gusUserStore.list());
  });

  router.post('/gus/roster/stage', express.json(), (req, res) => {
    try {
      const { username, extraTabs, powerActions } = req.body || {};
      const user = gusUserStore.stagePendingGrant(username, { extraTabs, powerActions });
      activityLog.add('admin', `${actor(req)} pre-staged a Fine Permissions grant for "${username}" (not yet logged in)`, actor(req));
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/gus/roster/:key/permissions', express.json(), (req, res) => {
    try {
      const { extraTabs, powerActions } = req.body || {};
      const perms = gusUserStore.setPermissions(req.params.key, { extraTabs, powerActions });
      activityLog.add('admin', `${actor(req)} updated Fine Permissions for "${req.params.key}"`, actor(req));
      res.json({ ok: true, permissions: perms });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/gus/roster/:key/disable', express.json(), (req, res) => {
    try {
      const { disabled, reason } = req.body || {};
      if (disabled === true && req.session.user.username.toLowerCase() === req.params.key.toLowerCase()) {
        throw new Error('You cannot disable your own account while signed in');
      }
      gusUserStore.setDisabled(req.params.key, disabled, reason);
      activityLog.add('admin', `${actor(req)} ${disabled ? 'disabled' : 're-enabled'} "${req.params.key}" for this app` + (disabled && reason ? ` — reason: ${reason}` : ''), actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/gus/roster/:key', (req, res) => {
    try {
      gusUserStore.remove(req.params.key);
      activityLog.add('admin', `${actor(req)} removed "${req.params.key}" from the local Fine Permissions roster`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------- GUS connection settings + the deliberately hard disable switch ---------- */
  router.get('/gus/settings', (req, res) => {
    const s = gusSettingsStore.read();
    // Never send the app secret back to the browser once set.
    res.json({ enabled: s.enabled, baseUrl: s.baseUrl, appId: s.appId, appSecretSet: !!s.appSecret });
  });

  router.put('/gus/settings', express.json(), async (req, res) => {
    try {
      const current = gusSettingsStore.read();
      const { enabled, baseUrl, appId, appSecret, confirmationPhrase, currentPassword, reason } = req.body || {};
      const next = { ...current };

      if (baseUrl !== undefined) {
        const trimmed = String(baseUrl).trim();
        if (!/^https?:\/\/.+/i.test(trimmed)) throw new Error('Base URL must start with http:// or https://');
        next.baseUrl = trimmed.replace(/\/$/, '');
      }
      if (appId !== undefined) next.appId = String(appId).trim();
      if (appSecret) next.appSecret = String(appSecret); // blank = keep existing, never blanked out accidentally

      if (enabled === false && current.enabled) {
        // This is the deliberately hard path — three separate checks, all
        // required, all logged with the reason attached.
        if (confirmationPhrase !== DISABLE_CONFIRMATION_PHRASE) {
          throw new Error(`Type "${DISABLE_CONFIRMATION_PHRASE}" exactly to confirm.`);
        }
        if (!reason || reason.trim().length < 10) {
          throw new Error('A written reason (at least 10 characters) is required to disable GUS.');
        }
        const verified = await reverifyCurrentUser(req, currentPassword, { userStore, gusClient });
        if (!verified) throw new Error('Current password is incorrect.');
        next.enabled = false;
        gusSettingsStore.write(next);
        activityLog.add('admin', `⚠ ${actor(req)} DISABLED GUS — reason: ${reason.trim()}`, actor(req));
        return res.json({ ok: true, settings: { enabled: false, baseUrl: next.baseUrl, appId: next.appId, appSecretSet: !!next.appSecret } });
      }

      if (enabled === true) next.enabled = true;
      gusSettingsStore.write(next);
      if (enabled === true && !current.enabled) {
        activityLog.add('admin', `${actor(req)} re-enabled GUS`, actor(req));
      } else {
        activityLog.add('admin', `${actor(req)} updated GUS connection settings`, actor(req));
      }
      res.json({ ok: true, settings: { enabled: next.enabled, baseUrl: next.baseUrl, appId: next.appId, appSecretSet: !!next.appSecret } });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
