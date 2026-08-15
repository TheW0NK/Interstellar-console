'use strict';
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./config');
const { UserStore, requireAuth, requireTab, scopedTab, requirePowerAction, requireGoodStanding } = require('./auth');
const { effectivePermissions } = require('./permissions');
const ServerRegistry = require('./servers');
const ActivityLog = require('./activity');
const FailedLoginStore = require('./failedLogins');

const powerRoutes = require('./routes/power');
const commandRoutes = require('./routes/command');
const filesRoutes = require('./routes/files');
const configRoutes = require('./routes/config');
const backupRoutes = require('./routes/backups');
const scheduleRoutes = require('./routes/schedules');
const playerRoutes = require('./routes/players');
const adminRoutes = require('./routes/admins');
const gusAdminRoutes = require('./routes/gusAdmin');
const sftpRoutes = require('./routes/sftp');
const pluginRoutes = require('./routes/plugins');
const activityRoutes = require('./routes/activity');
const brandingRoutes = require('./routes/branding');
const accountRoutes = require('./routes/account');
const userHistoryRoutes = require('./routes/userHistory');

const { UpdateChecker } = require('./updateChecker');
const { GusSettingsStore, GusUserStore } = require('./gusStore');
const { GusClient } = require('./gus');

const config = loadConfig();
const userStore = new UserStore(config.users.file);
const registry = new ServerRegistry(config);
const activityLog = new ActivityLog(config.activity.file);
const failedLoginStore = new FailedLoginStore(config.failedLogins.file);
const gusSettingsStore = new GusSettingsStore(config.gus.file);
const gusUserStore = new GusUserStore(config.gus.usersFile);
const gusClient = new GusClient(gusSettingsStore);
const updateChecker = (config.updates && config.updates.checkForUpdates !== false)
  ? new UpdateChecker({ includePrereleases: !!(config.updates && config.updates.includePrereleases) })
  : null;

/** Resolves "the current user's record" regardless of which system
 *  authenticated them — local UserStore keyed by username, or GUS's
 *  local Fine Permissions roster keyed by the stable uid GUS issued at
 *  login. Every shared permission middleware (requireTab,
 *  requirePowerAction, requireGoodStanding) goes through this instead of
 *  hardcoding one store, so the same route mounts work for both. */
const identity = {
  lookup(sessionUser) {
    if (!sessionUser) return null;
    if (sessionUser.authSource === 'gus') return gusUserStore.findByUid(sessionUser.uid);
    return userStore.findByUsername(sessionUser.username);
  },
};

const GUS_REVALIDATE_INTERVAL_MS = 5 * 60 * 1000;
/**
 * GUS-authenticated sessions get periodically re-checked against GUS's
 * /validate — this is what makes "sign out everywhere" (revoking a
 * session from GUS's own Active Sessions page) actually take effect here,
 * and picks up a forced password change or a GUS-side disable that
 * happened after this panel's session was created. Not on every single
 * request (that would mean every click depends on GUS being reachable) —
 * on an interval, tracked per-session.
 */
async function gusRevalidate(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.authSource !== 'gus') return next();
  const stale = !req.session.gusLastValidated || (Date.now() - req.session.gusLastValidated) > GUS_REVALIDATE_INTERVAL_MS;
  if (!stale) return next();

  try {
    const { body } = await gusClient.validate(req.session.gusToken);
    if (!body.valid) {
      return req.session.destroy(() => res.status(401).json({ error: 'Your session was ended (possibly from another app, or by an owner).' }));
    }
    gusUserStore.syncProfile(body.user);
    req.session.gusLastValidated = Date.now();
    next();
  } catch (err) {
    // GUS unreachable right now — don't kill an otherwise-valid local
    // session over a transient network blip; just skip the refresh and
    // try again on the next request past the interval.
    next();
  }
}

function currentPanelVersion() {
  try {
    const yaml = require('js-yaml');
    const fs = require('fs');
    const doc = yaml.load(fs.readFileSync(config.branding.file, 'utf8'));
    return (doc && doc.version) || '0.0.0';
  } catch (err) {
    return '0.0.0';
  }
}

if (userStore.isEmpty()) {
  console.warn('\n⚠  No administrators exist yet in ' + config.users.file);
  console.warn('   Run: node scripts/add-user.js <username> owner\n');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: config.panel.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------- auth routes ---------- */
app.post('/api/login', async (req, res) => {
  const { username, password, useLocalAuth } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const gusSettings = gusSettingsStore.read();
  if (gusSettings.enabled && !useLocalAuth) {
    return handleGusLogin(req, res, username, password);
  }
  return handleLocalLogin(req, res, username, password);
});

async function handleGusLogin(req, res, username, password) {
  let call;
  try {
    call = await gusClient.login(username, password);
  } catch (err) {
    // GUS unreachable — do not silently fall back to local (that would
    // undermine the whole point of GUS being the secure default). Surface
    // a clear error; the explicit local-account link on the login screen
    // is the deliberate, visible escape hatch for this situation.
    return res.status(503).json({ error: 'Could not reach GUS right now. If you have a local emergency account, use "Sign in with a local account instead."' });
  }
  const { httpStatus, body } = call;

  if (httpStatus === 401 && body.status === 'invalid_app') {
    console.error('GUS rejected this panel\'s app credentials — check config/gus.yml (appId/appSecret)');
    return res.status(503).json({ error: 'GUS integration is misconfigured. Contact an owner.' });
  }
  if (httpStatus === 429 || body.status === 'rate_limited') {
    if (body.retryAfterSeconds) res.set('Retry-After', String(body.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  }
  if (body.status === 'bad') {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (body.status === 'disabled') {
    activityLog.add('auth', `Blocked sign-in attempt — "${username}" is disabled (GUS)`, null);
    return res.status(403).json({ error: 'This account has been disabled.' });
  }
  if (body.status !== 'good' && body.status !== 'good_change_pw') {
    return res.status(502).json({ error: 'Unexpected response from GUS.' });
  }

  const gusUser = body.user;
  const roster = gusUserStore.upsertFromLogin(gusUser);

  if (roster.disabled) {
    activityLog.add('auth', `Blocked sign-in — "${gusUser.username}" is disabled for this app`, null);
    return res.status(403).json({ error: 'This account has been disabled for Interstellar Console specifically. Contact an owner.' });
  }

  req.session.user = { username: gusUser.username, role: gusUser.role, uid: gusUser.uid, authSource: 'gus' };
  req.session.gusToken = body.token;
  req.session.gusLastValidated = Date.now();

  activityLog.add('auth', `${gusUser.username} signed in via GUS`, gusUser.username);
  res.json({
    ok: true,
    user: gusUser.username,
    role: gusUser.role,
    permissions: effectivePermissions({ role: gusUser.role, permissions: roster.permissions }),
    theme: roster.theme || gusUser.theme || 'ember',
    requirePasswordChange: body.status === 'good_change_pw',
    singleServerId: registry.isSingleServer() ? registry.firstId() : null,
    authSource: 'gus',
  });
}

async function handleLocalLogin(req, res, username, password) {
  const result = userStore.verify(username, password);
  if (!result.ok) {
    failedLoginStore.add({ username, ip: clientIp(req), userAgent: req.headers['user-agent'], reason: result.reason });
    if (result.reason === 'disabled') {
      activityLog.add('auth', `Blocked sign-in attempt — "${username}" is disabled`, null);
      return res.status(403).json({ error: 'This account has been disabled.' });
    }
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  req.session.user = { username: result.user.username, role: result.user.role, authSource: 'local' };
  userStore.touchLogin(result.user.username);
  activityLog.add('auth', `${result.user.username} signed in (local account)`, result.user.username);
  const fullUser = userStore.findByUsername(result.user.username);
  res.json({
    ok: true,
    user: result.user.username,
    role: result.user.role,
    permissions: effectivePermissions(fullUser),
    theme: fullUser.theme || 'ember',
    requirePasswordChange: result.needsChange,
    singleServerId: registry.isSingleServer() ? registry.firstId() : null,
    authSource: 'local',
  });
}

app.post('/api/logout', async (req, res) => {
  if (req.session.user && req.session.user.authSource === 'gus' && req.session.gusToken) {
    try { await gusClient.logout(req.session.gusToken); } catch (err) { /* best-effort — destroy the local session regardless */ }
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', requireAuth, (req, res) => {
  const fullUser = identity.lookup(req.session.user);
  if (!fullUser) return req.session.destroy(() => res.status(401).json({ error: 'Account no longer exists' }));
  const isGus = req.session.user.authSource === 'gus';
  res.json({
    user: req.session.user.username,
    role: req.session.user.role,
    permissions: effectivePermissions(isGus ? { role: req.session.user.role, permissions: fullUser.permissions } : fullUser),
    theme: fullUser.theme || 'ember',
    requirePasswordChange: !!fullUser.mustChangePassword || (!isGus && userStore.isPasswordExpired(fullUser)),
    singleServerId: registry.isSingleServer() ? registry.firstId() : null,
    authSource: req.session.user.authSource,
  });
});

/* ---------- branding (public GETs, protected PUT handled inside the router) ---------- */
app.use('/api', brandingRoutes(config, activityLog, registry));

/* ---------- everything past this point requires a session in good standing ---------- */
app.use('/api', requireAuth);
app.use('/api', gusRevalidate);
app.use('/api', requireGoodStanding(identity));

// Self-service account management — every authenticated user, every role.
app.use('/api', accountRoutes(config, { userStore, gusUserStore, gusClient }, activityLog));

// Update check — owner-only "is there a newer release" notice. Returns
// null for non-owners or if checking is disabled/unavailable, rather than
// erroring, so the frontend can call this unconditionally after login.
app.get('/api/update-check', async (req, res) => {
  if (!updateChecker || req.session.user.role !== 'owner') return res.json(null);
  try {
    const result = await updateChecker.check(currentPanelVersion());
    res.json(result);
  } catch (err) {
    res.json(null);
  }
});

app.use('/api', activityRoutes(activityLog));

/* ---------- per-server routes ----------
 * Every server/proxy defined in servers.yml gets its own set of routers,
 * built ONCE at boot (not per-request — schedules.js registers cron jobs
 * in its constructor, so rebuilding it on every request would re-register
 * and duplicate-fire every scheduled task). Each server's router set is
 * mounted at its own literal path, /api/servers/<id>/*. Tab permissions
 * are still panel-wide, not per-server — if you can access Files at all,
 * you can access Files for any server you can see in the picker.
 *
 * IMPORTANT: this whole block, and the /api/servers list route, must be
 * registered BEFORE any broadly-mounted `app.use('/api', requireTab(...))`
 * middleware below (Administrator Management, User History) — Express
 * runs middleware in registration order for every request matching its
 * prefix, and requireTab() terminates the chain outright on failure
 * (no next()). A tab-gated middleware mounted at the bare '/api' prefix
 * and registered EARLIER would intercept and reject every /api/servers/*
 * request too, before the correctly-scoped per-route tab check downstream
 * ever got a chance to run — which is exactly the bug this ordering
 * avoids. (Caught via testing: a moderator granted extra 'files' access
 * was still rejected, because the earlier-registered 'admins' check was
 * eating the request first.) */
app.get('/api/servers', requireTab(identity, 'dashboard'), (req, res) => {
  res.json(registry.list());
});

function requireAnyTab(prefixes, ...tabIds) {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  return (req, res, next) => {
    if (!list.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    const user = identity.lookup(req.session.user);
    if (!user || user.disabled) return res.status(403).json({ error: 'Account disabled' });
    const perms = effectivePermissions(user);
    if (!tabIds.some((t) => perms.tabs.includes(t))) return res.status(403).json({ error: 'You do not have access to this section.' });
    next();
  };
}

registry.forEach((inst) => {
  const base = `/api/servers/${inst.id}`;
  app.use(base, powerRoutes(inst.pm, activityLog, requirePowerAction(identity)));
  app.use(base, commandRoutes(inst.pm, inst.statsSampler));
  app.use(base, scopedTab(identity, 'files', '/files'), filesRoutes(inst.serverConfig));
  app.use(base, scopedTab(identity, 'config', '/config'), configRoutes(inst.serverConfig, activityLog));
  app.use(base, scopedTab(identity, 'backups', '/backups'), backupRoutes(inst.serverConfig, inst.pm, activityLog));
  app.use(base, scopedTab(identity, 'schedules', '/schedules'), scheduleRoutes(inst.serverConfig, inst.pm, activityLog));
  app.use(base, scopedTab(identity, 'players', '/players'), playerRoutes(inst.serverConfig, inst.pm, activityLog));
  app.use(base, scopedTab(identity, 'sftp', '/sftp-info'), sftpRoutes(inst.serverConfig));
  app.use(base, requireAnyTab('/plugins', 'plugins-installed', 'plugins-installer'), pluginRoutes(inst.serverConfig, inst.pm, activityLog));
});
// Unknown server id under /api/servers/* — everything above only matches
// ids that actually exist, so anything else falls through to here.
app.use('/api/servers/:serverId', (req, res) => res.status(404).json({ error: 'No such server' }));

// Administrator Management — user list, the More dialog, Fine Permissions,
// and User History all live behind the single "admins" tab.
// Administrator Management is now the GUS Fine Permissions roster (see
// design notes in gusAdmin.js) — local account CRUD (add/edit/remove
// local emergency accounts, distinct from the GUS-account permission
// roster) moves to /api/local, deliberately not surfaced as a first-class
// tab; it exists for genuine "GUS is unreachable" recovery, managed via
// the CLI (scripts/add-user.js) or this API directly. These are
// deliberately registered LAST among the tab-gated routes — see the long
// comment above the per-server block for why the order matters.
app.use('/api', scopedTab(identity, 'admins', '/gus'), gusAdminRoutes({ gusUserStore, gusSettingsStore, gusClient, userStore, activityLog }));
app.use('/api/local', requireTab(identity, 'admins'), adminRoutes(userStore, activityLog));
app.use('/api', scopedTab(identity, 'admins', ['/user-history', '/failed-logins']), userHistoryRoutes(activityLog, failedLoginStore));

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- http + websocket server ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}
function broadcastToServer(serverId, msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.serverId === serverId) client.send(data);
  });
}

registry.forEach((inst) => {
  inst.pm.on('log', (entry) => broadcastToServer(inst.id, { type: 'log', entry }));
  inst.pm.on('state', (state) => broadcastToServer(inst.id, { type: 'state', state }));
});
activityLog.on('add', (entry) => broadcastAll({ type: 'activity', entry }));

wss.on('connection', (ws, req) => {
  // Websocket connections inherit the express-session cookie check performed
  // implicitly by only exposing /ws to browsers that already loaded the
  // authenticated app shell. For stricter enforcement, parse the session
  // cookie here against the same store used by `session()` above.
  const url = new URL(req.url, 'http://internal');
  const serverId = url.searchParams.get('server');
  const inst = serverId ? registry.get(serverId) : null;
  ws.serverId = inst ? inst.id : null;

  if (inst) {
    ws.send(JSON.stringify({ type: 'history', entries: inst.pm.history }));
    ws.send(JSON.stringify({ type: 'state', state: inst.pm.state }));
  }
  ws.send(JSON.stringify({ type: 'activity-history', entries: activityLog.list(30) }));
});

/* ---------- periodic stats push, per server ---------- */
setInterval(async () => {
  if (wss.clients.size === 0) return;
  registry.forEach(async (inst) => {
    const hasSubscribers = Array.from(wss.clients).some((c) => c.readyState === 1 && c.serverId === inst.id);
    if (!hasSubscribers) return;
    try {
      const stats = await inst.statsSampler.sample();
      broadcastToServer(inst.id, { type: 'stats', state: inst.pm.state, stats, uptimeMs: inst.pm.getUptimeMs() });
    } catch (err) {
      // never let a bad sample crash the loop
    }
  });
}, 2000);

server.listen(config.panel.port, config.panel.bind, () => {
  console.log(`Interstellar Console listening on http://${config.panel.bind}:${config.panel.port}`);
  registry.forEach((inst) => console.log(`  - [${inst.id}] ${inst.name}: ${inst.serverConfig.server.directory}/${inst.serverConfig.server.jarFile}`));
});

process.on('SIGINT', () => {
  console.log('\nShutting down panel (server processes are left running if online)...');
  process.exit(0);
});
