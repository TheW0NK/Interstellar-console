'use strict';
const fs = require('fs');
const yaml = require('js-yaml');
const { effectivePermissions } = require('./permissions');

/* ---------- GUS connection settings (config/gus.yml) ---------- */
class GusSettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    try {
      const doc = yaml.load(fs.readFileSync(this.filePath, 'utf8')) || {};
      return {
        enabled: doc.enabled !== false, // on by default
        baseUrl: doc.baseUrl || 'http://127.0.0.1:4000',
        appId: doc.appId || '',
        appSecret: doc.appSecret || '',
      };
    } catch (err) {
      return { enabled: true, baseUrl: 'http://127.0.0.1:4000', appId: '', appSecret: '' };
    }
  }

  write(settings) {
    const header =
      '# =============================================================================\n' +
      '# Interstellar Console — GUS settings\n' +
      '# =============================================================================\n\n';
    fs.writeFileSync(this.filePath, header + yaml.dump(settings, { lineWidth: -1 }), 'utf8');
  }
}

/* ---------- Local roster of GUS-authenticated accounts ---------- */
/**
 * Keyed by `uid` (GUS's stable identifier), NOT username — GUS explicitly
 * documents that usernames can be renamed by an owner but uid never
 * changes, so keying on username here would silently orphan Fine
 * Permission grants across a rename. There is deliberately no "create" or
 * "provision" method: GUS already decides whether an account exists and
 * is allowed to log in. A row here just means "we've seen this uid log
 * in before, and/or an owner staged a permission grant for this username
 * in advance" — see upsertFromLogin() and stagePendingGrant().
 */
class GusUserStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _defaults() {
    return {
      theme: 'ember',
      avatarExt: null,
      lastLogin: null,
      // Purely local/app-scoped — lets an owner block a GUS-valid account
      // from just Interstellar Console without touching their GUS account
      // at all. GUS's own disable state isn't cached here; it's caught
      // live whenever /validate returns valid:false (see requireGoodStanding).
      disabled: false,
      disabledReason: null,
      mustChangePassword: false, // cached from GUS; refreshed on login and periodic re-validation
      permissions: { extraTabs: [], powerActions: false },
    };
  }

  _read() {
    if (!fs.existsSync(this.filePath)) return { users: [] };
    try {
      const doc = yaml.load(fs.readFileSync(this.filePath, 'utf8')) || {};
      if (!Array.isArray(doc.users)) doc.users = [];
      doc.users = doc.users.map((u) => ({ ...this._defaults(), ...u }));
      return doc;
    } catch (err) {
      return { users: [] };
    }
  }

  _write(doc) {
    const header =
      '# =============================================================================\n' +
      '# Interstellar Console — Fine Permissions for GUS accounts\n' +
      '# =============================================================================\n' +
      '# Auto-populated as people log in via GUS — never edited by hand for account\n' +
      '# existence/role, only for the `permissions` and `localDisabled` fields.\n' +
      '# username/role/fullName here are a cache of what GUS last reported, shown\n' +
      '# for readability — GUS is always re-asked at actual login/validate time.\n' +
      '# =============================================================================\n\n';
    fs.writeFileSync(this.filePath, header + yaml.dump(doc, { lineWidth: -1 }), 'utf8');
  }

  list() {
    return this._read().users.map((u) => ({ ...u, effective: effectivePermissions({ role: u.role, permissions: u.permissions }) }));
  }

  findByUid(uid) {
    return this._read().users.find((u) => u.uid === uid);
  }

  findByUsername(username) {
    // Used by the shared permission middleware, which is written generically
    // against "some identifier" — for GUS accounts that identifier is uid,
    // but the middleware still calls this method name. See auth.js.
    return this._read().users.find((u) => (u.username || '').toLowerCase() === (username || '').toLowerCase());
  }

  /** Called on every successful GUS login — creates the row on first sight,
   *  refreshes the cached display fields on every subsequent one. Also
   *  resolves any pending username-based grant staged before this uid was
   *  ever seen (see stagePendingGrant). */
  upsertFromLogin(gusUser) {
    const doc = this._read();
    let user = doc.users.find((u) => u.uid === gusUser.uid);
    if (!user) {
      // A pending grant staged by username (before this person ever logged
      // in) takes over as the real row instead of creating a duplicate.
      const pending = doc.users.find((u) => u.pending && (u.username || '').toLowerCase() === gusUser.username.toLowerCase());
      if (pending) {
        user = pending;
        user.pending = false;
      } else {
        user = { ...this._defaults(), uid: gusUser.uid };
        doc.users.push(user);
      }
    }
    user.uid = gusUser.uid;
    user.username = gusUser.username;
    user.role = gusUser.role;
    user.fullName = gusUser.fullName || '';
    user.mustChangePassword = !!gusUser.mustChangePassword;
    user.lastLogin = new Date().toISOString();
    this._write(doc);
    return user;
  }

  /** Stage a Fine Permissions grant for a username that hasn't logged in
   *  yet — resolved automatically to a real uid on that person's first
   *  successful GUS login. */
  stagePendingGrant(username, permissions) {
    if (!username || !username.trim()) throw new Error('Username is required');
    const doc = this._read();
    if (doc.users.some((u) => (u.username || '').toLowerCase() === username.toLowerCase())) {
      throw new Error('That username already has a roster entry (either already logged in, or already staged)');
    }
    const user = {
      ...this._defaults(), uid: null, username: username.trim(), role: null, fullName: '', pending: true,
      permissions: { extraTabs: Array.isArray(permissions.extraTabs) ? permissions.extraTabs : [], powerActions: !!permissions.powerActions },
    };
    doc.users.push(user);
    this._write(doc);
    return user;
  }

  setPermissions(uidOrUsername, permissions) {
    const doc = this._read();
    const user = doc.users.find((u) => u.uid === uidOrUsername || u.username === uidOrUsername);
    if (!user) throw new Error('No such user in the local roster');
    const extraTabs = Array.isArray(permissions.extraTabs) ? permissions.extraTabs.filter((t) => typeof t === 'string') : [];
    user.permissions = { extraTabs, powerActions: !!permissions.powerActions };
    this._write(doc);
    return user.permissions;
  }

  setDisabled(uidOrUsername, disabled, reason) {
    const doc = this._read();
    const user = doc.users.find((u) => u.uid === uidOrUsername || u.username === uidOrUsername);
    if (!user) throw new Error('No such user in the local roster');
    user.disabled = !!disabled;
    user.disabledReason = disabled ? (reason || null) : null;
    this._write(doc);
    return user;
  }

  updatePreferences(uid, updates) {
    const doc = this._read();
    const user = doc.users.find((u) => u.uid === uid);
    if (!user) throw new Error('No such user in the local roster');
    if (updates.theme !== undefined) user.theme = updates.theme;
    if (updates.avatarExt !== undefined) user.avatarExt = updates.avatarExt;
    this._write(doc);
    return user;
  }

  /** Refreshes cached display fields (role, name, mustChangePassword) from
   *  a GUS profile without touching lastLogin — used by the periodic
   *  re-validation in requireGoodStanding, not actual logins. No-op if
   *  this uid has no roster row yet (shouldn't happen in practice, since
   *  a row is always created at login before any revalidation occurs). */
  syncProfile(gusUser) {
    const doc = this._read();
    const user = doc.users.find((u) => u.uid === gusUser.uid);
    if (!user) return null;
    user.username = gusUser.username;
    user.role = gusUser.role;
    user.fullName = gusUser.fullName || '';
    user.mustChangePassword = !!gusUser.mustChangePassword;
    this._write(doc);
    return user;
  }

  remove(uidOrUsername) {
    const doc = this._read();
    const before = doc.users.length;
    doc.users = doc.users.filter((u) => u.uid !== uidOrUsername && u.username !== uidOrUsername);
    if (doc.users.length === before) throw new Error('No such user in the local roster');
    this._write(doc);
  }
}

module.exports = { GusSettingsStore, GusUserStore };
