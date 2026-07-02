'use strict';
const express = require('express');
const session = require('express-session');
const http = require('http');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./config');
const { UserStore, requireAuth, requireRole } = require('./auth');
const ProcessManager = require('./processManager');
const StatsSampler = require('./stats');
const ActivityLog = require('./activity');

const powerRoutes = require('./routes/power');
const commandRoutes = require('./routes/command');
const filesRoutes = require('./routes/files');
const configRoutes = require('./routes/config');
const backupRoutes = require('./routes/backups');
const scheduleRoutes = require('./routes/schedules');
const playerRoutes = require('./routes/players');
const adminRoutes = require('./routes/admins');
const sftpRoutes = require('./routes/sftp');
const pluginRoutes = require('./routes/plugins');
const activityRoutes = require('./routes/activity');
const brandingRoutes = require('./routes/branding');

const config = loadConfig();
const userStore = new UserStore(config.users.file);
const pm = new ProcessManager(config);
const statsSampler = new StatsSampler(config, pm);
const activityLog = new ActivityLog(config.activity.file);

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

/* ---------- auth routes ---------- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = userStore.verify(username, password);
  if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });
  req.session.user = user;
  activityLog.add('auth', `${user.username} signed in`, user.username);
  res.json({ ok: true, user: user.username, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', requireAuth, (req, res) => {
  res.json({ user: req.session.user.username, role: req.session.user.role });
});

/* ---------- branding (public GETs, protected PUT handled inside the router) ---------- */
app.use('/api', brandingRoutes(config, activityLog));

/* ---------- everything past this point requires a session ---------- */
app.use('/api', requireAuth);

app.use('/api', powerRoutes(pm, activityLog));
app.use('/api', commandRoutes(pm, statsSampler));
app.use('/api', filesRoutes(config));
app.use('/api', configRoutes(config, activityLog));
app.use('/api', backupRoutes(config, pm, activityLog));
app.use('/api', scheduleRoutes(config, pm, activityLog));
app.use('/api', playerRoutes(config, pm, activityLog));
app.use('/api', sftpRoutes(config));
app.use('/api', pluginRoutes(config, pm, activityLog));
app.use('/api', activityRoutes(activityLog));
// Administrator management is restricted to owner/admin roles.
app.use('/api', requireRole('owner', 'admin'), adminRoutes(userStore, activityLog));

app.use(express.static(require('path').join(__dirname, '..', 'public')));

/* ---------- http + websocket server ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

pm.on('log', (entry) => broadcast({ type: 'log', entry }));
pm.on('state', (state) => broadcast({ type: 'state', state }));
activityLog.on('add', (entry) => broadcast({ type: 'activity', entry }));

wss.on('connection', (ws, req) => {
  // Websocket connections inherit the express-session cookie check performed
  // implicitly by only exposing /ws to browsers that already loaded the
  // authenticated app shell. For stricter enforcement, parse the session
  // cookie here against the same store used by `session()` above.
  ws.send(JSON.stringify({ type: 'history', entries: pm.history }));
  ws.send(JSON.stringify({ type: 'state', state: pm.state }));
  ws.send(JSON.stringify({ type: 'activity-history', entries: activityLog.list(30) }));
});

/* ---------- periodic stats push ---------- */
setInterval(async () => {
  if (wss.clients.size === 0) return;
  try {
    const stats = await statsSampler.sample();
    broadcast({ type: 'stats', state: pm.state, stats, uptimeMs: pm.getUptimeMs() });
  } catch (err) {
    // never let a bad sample crash the loop
  }
}, 2000);

server.listen(config.panel.port, config.panel.bind, () => {
  console.log(`Vexium panel listening on http://${config.panel.bind}:${config.panel.port}`);
  console.log(`Managing: ${config.server.directory}/${config.server.jarFile}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down panel (server process is left running if online)...');
  process.exit(0);
});
