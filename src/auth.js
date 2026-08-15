'use strict';
const fs = require('fs');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const { effectivePermissions } = require('./permissions');

const VALID_ROLES = ['owner', 'admin', 'moderator'];

function defaultUserFields() {
  return {
    fullName: '',
    description: '',
    disabled: false,
    mustChangePassword: false,
    cannotChangePassword: false,
    passwordNeverExpires: true,
    passwordExpiresAt: null,
    lastLogin: null,
    theme: 'ember',
    avatarExt: null,
    permissions: { extraTabs: [], powerActions: false },
  };
}

function isPasswordExpired(user) {
  if (user.passwordNeverExpires) return false;
  if (!user.passwordExpiresAt) return false;
  const expires = new Date(user.passwordExpiresAt).getTime();
  if (Number.isNaN(expires)) return false;
  return Date.now() > expires;
}

class UserStore {
  constructor(usersFilePath) {
    this.filePath = usersFilePath;
  }

  _read() {
    if (!fs.existsSync(this.filePath)) return { users: [] };
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const doc = yaml.load(raw) || {};
    if (!Array.isArray(doc.users)) doc.users = [];
    // Backfill defaults for users created under the old, simpler schema
    // so older users.yml files keep working without a migration step.
    doc.users = doc.users.map((u) => ({ ...defaultUserFields(), ...u }));
    return doc;
  }

  _write(doc) {
    const header =
      '# =============================================================================\n' +
      '# Vexium Panel — administrators\n' +
      '# =============================================================================\n' +
      '# Passwords are bcrypt hashes. Never edit in plaintext passwords.\n' +
      '# Valid roles: owner, admin, moderator\n' +
      '# =============================================================================\n\n';
    fs.writeFileSync(this.filePath, header + yaml.dump(doc, { lineWidth: -1 }), 'utf8');
  }

  list() {
    return this._read().users.map(({ passwordHash, ...rest }) => ({
      ...rest,
      passwordExpired: isPasswordExpired(rest),
      effective: effectivePermissions(rest),
    }));
  }

  findByUsername(username) {
    return this._read().users.find((u) => u.username.toLowerCase() === (username || '').toLowerCase());
  }

  /** Safe (no passwordHash) copy of a single user, or null. */
  getProfile(username) {
    const user = this.findByUsername(username);
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return { ...safe, passwordExpired: isPasswordExpired(user), effective: effectivePermissions(user) };
  }

  isPasswordExpired(user) {
    return isPasswordExpired(user);
  }

  /**
   * Returns { ok: true, user: {username, role}, needsChange } on success,
   * or { ok: false, reason: 'bad-credentials' | 'disabled' } on failure.
   * Bad password and unknown username both report 'bad-credentials' so we
   * never reveal which part was wrong.
   */
  verify(username, password) {
    const user = this.findByUsername(username);
    if (!user) return { ok: false, reason: 'bad-credentials' };
    if (!bcrypt.compareSync(password, user.passwordHash)) return { ok: false, reason: 'bad-credentials' };
    if (user.disabled) return { ok: false, reason: 'disabled' };
    const needsChange = !!user.mustChangePassword || isPasswordExpired(user);
    return { ok: true, user: { username: user.username, role: user.role }, needsChange };
  }

  verifyPassword(username, password) {
    const user = this.findByUsername(username);
    if (!user) return false;
    return bcrypt.compareSync(password, user.passwordHash);
  }

  add({ username, password, role, fullName, description }) {
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
    const doc = this._read();
    if (doc.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('A user with that username already exists');
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = {
      ...defaultUserFields(),
      username,
      passwordHash,
      role,
      fullName: fullName || '',
      description: description || '',
    };
    doc.users.push(user);
    this._write(doc);
    return { username, role };
  }

  remove(username) {
    const doc = this._read();
    const before = doc.users.length;
    doc.users = doc.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
    if (doc.users.length === before) throw new Error('No such user');
    this._write(doc);
  }

  setRole(username, role) {
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('No such user');
    user.role = role;
    this._write(doc);
  }

  resetPassword(username, newPassword, { clearMustChange = true } = {}) {
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('No such user');
    user.passwordHash = bcrypt.hashSync(newPassword, 10);
    if (clearMustChange) user.mustChangePassword = false;
    this._write(doc);
  }

  touchLogin(username) {
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return;
    user.lastLogin = new Date().toISOString();
    this._write(doc);
  }

  /**
   * General profile updater used by both the self-service Account page and
   * the Administrator Management "More" dialog. Only the fields present in
   * `updates` are touched. Username rename is handled separately by
   * rename() since it changes the record's key.
   */
  update(username, updates) {
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('No such user');

    const editable = [
      'fullName', 'description', 'theme', 'disabled',
      'mustChangePassword', 'cannotChangePassword', 'passwordNeverExpires',
      'passwordExpiresAt', 'avatarExt',
    ];
    for (const key of editable) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) user[key] = updates[key];
    }
    // These two are mutually exclusive by design (matches how AD treats
    // them) — enforce it server-side too, not just in the UI.
    if (updates.mustChangePassword === true) user.cannotChangePassword = false;
    if (updates.cannotChangePassword === true) user.mustChangePassword = false;

    this._write(doc);
    return this.getProfile(user.username);
  }

  setPermissions(username, permissions) {
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('No such user');
    const extraTabs = Array.isArray(permissions.extraTabs) ? permissions.extraTabs.filter((t) => typeof t === 'string') : [];
    user.permissions = { extraTabs, powerActions: !!permissions.powerActions };
    this._write(doc);
    return user.permissions;
  }

  rename(oldUsername, newUsername) {
    if (!newUsername || !newUsername.trim()) throw new Error('New username cannot be empty');
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === oldUsername.toLowerCase());
    if (!user) throw new Error('No such user');
    if (newUsername.toLowerCase() !== oldUsername.toLowerCase() &&
        doc.users.some((u) => u.username.toLowerCase() === newUsername.toLowerCase())) {
      throw new Error('That username is already taken');
    }
    user.username = newUsername.trim();
    this._write(doc);
    return user.username;
  }

  isEmpty() {
    return this._read().users.length === 0;
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

/**
 * Gate a route group by tab id, using *current* effective permissions
 * (role default + Fine Permission overrides) looked up fresh from disk on
 * every request — so revoking access takes effect immediately, without
 * waiting for the user to log out and back in.
 */
function requireTab(identity, tabId) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = identity.lookup(req.session.user);
    if (!user || user.disabled) return res.status(403).json({ error: 'Account disabled' });
    const perms = effectivePermissions(user);
    if (!perms.tabs.includes(tabId)) return res.status(403).json({ error: 'You do not have access to this section.' });
    next();
  };
}

/**
 * When multiple tab-gated route groups are mounted at the SAME base path
 * (e.g. every per-server route lives under /api/servers/<id>/*), chaining
 * requireTab() directly is unsafe: Express matches app.use(base, ...) as
 * a PREFIX for every request under that base, in registration order, and
 * a failed requireTab() terminates the chain outright (no next()) — so a
 * user who lacks 'files' but has 'backups' gets wrongly blocked by the
 * earlier-registered files gate before ever reaching their own
 * legitimately-permitted backups route. (Found via testing — a moderator
 * granted only 'backups' access was rejected with a "files" error.)
 *
 * This wraps requireTab so it only actually runs for requests whose path
 * (relative to the shared mount) starts with one of this route group's
 * own prefixes — anything else passes straight through to whatever's
 * registered next.
 */
function scopedTab(identity, tabId, prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  const gate = requireTab(identity, tabId);
  return (req, res, next) => {
    if (!list.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    return gate(req, res, next);
  };
}

/** Gate an action (not a whole tab) by the effective powerActions grant. */
function requirePowerAction(identity) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = identity.lookup(req.session.user);
    if (!user || user.disabled) return res.status(403).json({ error: 'Account disabled' });
    const perms = effectivePermissions(user);
    if (!perms.powerActions) return res.status(403).json({ error: 'You do not have permission to control the server process.' });
    next();
  };
}

/**
 * Applied globally after requireAuth. Kills the session outright if the
 * account was disabled mid-session, and blocks every route except a small
 * allowlist if the account has a pending forced password change — so a
 * user can't just click around the panel with a stale/expired password.
 */
function requireGoodStanding(identity) {
  // NOTE: this middleware is mounted via app.use('/api', ...), so Express
  // strips the "/api" mount prefix from req.path for the duration of this
  // handler — req.path here is "/account", not "/api/account".
  const ALLOWED_WHILE_CHANGE_REQUIRED = new Set([
    '/session', '/logout', '/account/password', '/account',
  ]);
  return (req, res, next) => {
    if (!req.session || !req.session.user) return next();
    const user = identity.lookup(req.session.user);
    if (!user) {
      return req.session.destroy(() => res.status(401).json({ error: 'Account no longer exists' }));
    }
    if (user.disabled) {
      return req.session.destroy(() => res.status(403).json({ error: 'This account has been disabled.' }));
    }
    const needsChange = !!user.mustChangePassword || isPasswordExpired(user);
    if (needsChange && !ALLOWED_WHILE_CHANGE_REQUIRED.has(req.path)) {
      return res.status(428).json({ error: 'A password change is required before continuing.', requirePasswordChange: true });
    }
    next();
  };
}

module.exports = { UserStore, requireAuth, requireRole, requireTab, scopedTab, requirePowerAction, requireGoodStanding, isPasswordExpired, VALID_ROLES };
