'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const ACTIONS = {
  restart: { label: 'Restart server', run: (pm) => pm.restart() },
  stop: { label: 'Stop server', run: (pm) => pm.stop() },
  save_all: { label: 'Save all', run: (pm) => pm.sendCommand('save-all') },
  broadcast: { label: 'Broadcast message', run: (pm, sched) => pm.sendCommand('say ' + (sched.message || 'Scheduled announcement')) },
};

class ScheduleStore {
  constructor(filePath, pm, activityLog) {
    this.filePath = filePath;
    this.pm = pm;
    this.activityLog = activityLog;
    this.jobs = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, '[]');
    }
    const list = JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '[]');
    list.forEach((s) => this._register(s));
  }

  _save(list) {
    fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2));
  }

  _all() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '[]');
  }

  _register(sched) {
    if (!ACTIONS[sched.action]) return;
    if (!cron.validate(sched.cron)) return;
    const existing = this.jobs.get(sched.id);
    if (existing) existing.stop();
    const task = cron.schedule(sched.cron, () => {
      if (!sched.enabled) return;
      ACTIONS[sched.action].run(this.pm, sched)
        .then(() => {
          this.activityLog.add('schedule', `Schedule "${sched.name}" ran (${ACTIONS[sched.action].label})`, null);
        })
        .catch((err) => {
          this.pm.pushLog(`Schedule "${sched.name}" failed: ${err.message}`, 'ERROR');
          this.activityLog.add('schedule', `Schedule "${sched.name}" failed: ${err.message}`, null);
        });
    });
    this.jobs.set(sched.id, task);
  }

  list() {
    return this._all();
  }

  add({ name, cronExpr, action, message, enabled }) {
    if (!ACTIONS[action]) throw new Error('Unknown action: ' + action);
    if (!cron.validate(cronExpr)) throw new Error('Invalid cron expression');
    const list = this._all();
    const sched = {
      id: 'sched_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || ACTIONS[action].label,
      cron: cronExpr,
      action,
      message: message || '',
      enabled: enabled !== false,
    };
    list.push(sched);
    this._save(list);
    this._register(sched);
    return sched;
  }

  setEnabled(id, enabled) {
    const list = this._all();
    const sched = list.find((s) => s.id === id);
    if (!sched) throw new Error('No such schedule');
    sched.enabled = enabled;
    this._save(list);
    this._register(sched);
  }

  remove(id) {
    const list = this._all();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) throw new Error('No such schedule');
    this._save(next);
    const job = this.jobs.get(id);
    if (job) { job.stop(); this.jobs.delete(id); }
  }
}

module.exports = function scheduleRoutes(config, pm, activityLog) {
  const router = express.Router();
  const store = new ScheduleStore(config.schedules.file, pm, activityLog);

  function actor(req) {
    return req.session && req.session.user ? req.session.user.username : null;
  }

  router.get('/schedules', (req, res) => {
    res.json({ schedules: store.list(), actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label })) });
  });

  router.post('/schedules', express.json(), (req, res) => {
    try {
      const sched = store.add({
        name: req.body.name,
        cronExpr: req.body.cron,
        action: req.body.action,
        message: req.body.message,
        enabled: req.body.enabled,
      });
      activityLog.add('schedule', `${actor(req)} created schedule "${sched.name}" (${sched.cron})`, actor(req));
      res.json({ ok: true, schedule: sched });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/schedules/:id', express.json(), (req, res) => {
    try {
      store.setEnabled(req.params.id, !!req.body.enabled);
      activityLog.add('schedule', `${actor(req)} ${req.body.enabled ? 'enabled' : 'disabled'} a schedule`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/schedules/:id', (req, res) => {
    try {
      store.remove(req.params.id);
      activityLog.add('schedule', `${actor(req)} deleted a schedule`, actor(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
