'use strict';
const express = require('express');

module.exports = function sftpRoutes(config) {
  const router = express.Router();
  router.get('/sftp-info', (req, res) => {
    res.json({
      host: config.sftp.host,
      port: config.sftp.port,
      username: config.sftp.username,
      connectionString: `sftp://${config.sftp.username}@${config.sftp.host}:${config.sftp.port}`,
      note: 'SFTP/SSH is provided by the OS, not this panel. Password is whatever you set for that system account.',
    });
  });
  return router;
};
