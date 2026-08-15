'use strict';
const express = require('express');

module.exports = function userHistoryRoutes(activityLog, failedLoginStore) {
  const router = express.Router();

  router.get('/user-history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    res.json({ activity: activityLog.list(limit) });
  });

  router.get('/failed-logins/count', (req, res) => {
    // "recent" = last 24 hours, for the ticker badge
    res.json({ count: failedLoginStore.countRecent(24 * 60 * 60 * 1000) });
  });

  router.get('/failed-logins', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json(failedLoginStore.list(limit));
  });

  return router;
};
