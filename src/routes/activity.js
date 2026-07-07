'use strict';
const express = require('express');

module.exports = function activityRoutes(activityLog) {
  const router = express.Router();

  router.get('/activity', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
    res.json(activityLog.list(limit));
  });

  return router;
};
