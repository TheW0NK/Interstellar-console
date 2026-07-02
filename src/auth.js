'use strict';
const fs = require('fs');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');

class UserStore {
  constructor(usersFilePath) {
    this.filePath = usersFilePath;
  }

  _read() {
    if (!fs.existsSync(this.filePath)) return { users: [] };
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const doc = yaml.load(raw) || {};
    if (!Array.isArray(doc.users)) doc.users = [];
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
    return this._read().users.map(({ passwordHash, ...rest }) => rest);
  }

  findByUsername(username) {
    return this._read().users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  }

  verify(username, password) {
    const user = this.findByUsername(username);
    if (!user) return null;
    if (!bcrypt.compareSync(password, user.passwordHash)) return null;
    return { username: user.username, role: user.role };
  }

  add({ username, password, role }) {
    const doc = this._read();
    if (doc.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('A user with that username already exists');
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    doc.users.push({ username, passwordHash, role });
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
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('No such user');
    user.role = role;
    this._write(doc);
  }

  resetPassword(username, newPassword) {
    const doc = this._read();
    const user = doc.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('No such user');
    user.passwordHash = bcrypt.hashSync(newPassword, 10);
    this._write(doc);
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

module.exports = { UserStore, requireAuth, requireRole };
