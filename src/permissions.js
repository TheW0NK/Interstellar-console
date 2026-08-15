'use strict';

/**
 * Three roles, each with a default tab ceiling. "account" (My Account,
 * self-service) is available to everyone regardless of role — it's not a
 * privilege, it's just where you manage your own login.
 *
 * "admins" (Administrator Management — user list, the More dialog, Fine
 * Permissions, and User History all live behind this one tab) is
 * owner-only by default. It's still just a tab like any other, so an
 * owner *can* delegate it to someone else via that user's Fine
 * Permissions if they explicitly choose to — see effectivePermissions()
 * below. That's a deliberate consequence of "overrides can grant beyond
 * the role default," not an oversight.
 */
const ROLE_TABS = {
  owner: [
    'dashboard', 'console', 'files', 'backups', 'schedules', 'tasks',
    'config', 'plugins-installed', 'plugins-installer', 'players', 'sftp',
    'admins', 'account',
  ],
  admin: [
    'dashboard', 'console', 'files', 'backups', 'schedules', 'tasks',
    'config', 'plugins-installed', 'plugins-installer', 'players', 'sftp',
    'account',
  ],
  moderator: ['dashboard', 'console', 'tasks', 'players', 'account'],
};

// Power actions (Start/Restart/Stop/Kill) are a capability, not a tab —
// moderators can see the Dashboard and Quick Tasks but can't use them to
// take the server down.
const ROLE_POWER_ACTIONS = {
  owner: true,
  admin: true,
  moderator: false,
};

const ALL_TABS = Array.from(new Set(Object.values(ROLE_TABS).flat()));

function effectivePermissions(user) {
  const role = ROLE_TABS[user.role] ? user.role : 'moderator';
  const baseTabs = new Set(ROLE_TABS[role]);
  const extra = (user.permissions && Array.isArray(user.permissions.extraTabs)) ? user.permissions.extraTabs : [];
  extra.forEach((t) => { if (ALL_TABS.includes(t)) baseTabs.add(t); });

  const basePower = !!ROLE_POWER_ACTIONS[role];
  const extraPower = !!(user.permissions && user.permissions.powerActions);

  return {
    tabs: Array.from(baseTabs),
    powerActions: basePower || extraPower,
  };
}

module.exports = { ROLE_TABS, ROLE_POWER_ACTIONS, ALL_TABS, effectivePermissions };
