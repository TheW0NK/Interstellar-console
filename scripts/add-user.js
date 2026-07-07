#!/usr/bin/env node
'use strict';
// Usage: node scripts/add-user.js <username> <owner|admin|moderator>
// Prompts for a password (hidden), hashes it with bcrypt, appends to config/users.yml

const readline = require('readline');
const { loadConfig } = require('../src/config');
const { UserStore } = require('../src/auth');

const [, , username, role] = process.argv;
const validRoles = ['owner', 'admin', 'moderator'];

if (!username || !validRoles.includes(role)) {
  console.error('Usage: node scripts/add-user.js <username> <owner|admin|moderator>');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    let input = '';
    process.stdout.write(question);
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', function handler(char) {
      char = char.toString('utf8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        rl.close();
        resolve(input);
      } else if (char === '\u0003') {
        process.exit(1);
      } else if (char === '\u007f') {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    });
  });
}

(async () => {
  const config = loadConfig();
  const store = new UserStore(config.users.file);

  const password = await promptHidden(`Password for "${username}": `);
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const confirm = await promptHidden('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords did not match.');
    process.exit(1);
  }

  try {
    store.add({ username, password, role });
    console.log(`Added ${role} "${username}" to ${config.users.file}`);
  } catch (err) {
    console.error('Failed: ' + err.message);
    process.exit(1);
  }
})();
