'use strict';

/**
 * Ranks mirror Passport's (formerly GAM / GUS) built-in ranks, so a
 * Passport account's `role` maps onto this panel's access without
 * translation:
 *
 *   trustedInstaller    "Provider"        full access (bootstrap account)
 *   systemAdministrator "Sysadmin"        full access (was "owner")
 *   elevatedStaff       "ElevatedAdmins"  everything but admin mgmt (was "admin")
 *   staff               "StaffUsers"      view + console only (was "moderator")
 *
 * The old owner/admin/moderator names are still accepted everywhere (an
 * existing users.yml, a stale roster cache, a script) and normalized to
 * the new names via normalizeRole() — nothing has to be migrated by hand.
 *
 * "account" (My Account, self-service) is available to everyone regardless
 * of rank — it's not a privilege, it's just where you manage your own login.
 *
 * "admins" (Administrator Management — user list, the More dialog, Fine
 * Permissions, and User History all live behind this one tab) is
 * full-access-only by default. It's still just a tab like any other, so a
 * Sysadmin *can* delegate it to someone else via that user's Fine
 * Permissions if they explicitly choose to — see effectivePermissions()
 * below. That's a deliberate consequence of "overrides can grant beyond
 * the rank default," not an oversight.
 */
const FULL_TABS = [
  'dashboard', 'console', 'files', 'backups', 'schedules', 'tasks',
  'config', 'plugins-installed', 'plugins-installer', 'players', 'sftp',
  'admins', 'account',
];
const ELEVATED_TABS = FULL_TABS.filter((t) => t !== 'admins');
const STAFF_TABS = ['dashboard', 'console', 'tasks', 'players', 'account'];

const RANKS = {
  trustedInstaller: { label: 'Provider', color: '#5b9dd9', fullAccess: true },
  systemAdministrator: { label: 'Sysadmin', color: '#ff8a3d', fullAccess: true },
  elevatedStaff: { label: 'ElevatedAdmins', color: '#a58bd9', fullAccess: false },
  staff: { label: 'StaffUsers', color: '#8b93a1', fullAccess: false },
};

const LEGACY_ROLE_ALIASES = {
  owner: 'systemAdministrator',
  admin: 'elevatedStaff',
  moderator: 'staff',
};

const ROLE_TABS = {
  trustedInstaller: FULL_TABS,
  systemAdministrator: FULL_TABS,
  elevatedStaff: ELEVATED_TABS,
  staff: STAFF_TABS,
};

// Power actions (Start/Restart/Stop/Kill) are a capability, not a tab —
// StaffUsers can see the Dashboard and Quick Tasks but can't use them to
// take the server down.
const ROLE_POWER_ACTIONS = {
  trustedInstaller: true,
  systemAdministrator: true,
  elevatedStaff: true,
  staff: false,
};

const ALL_TABS = Array.from(new Set(Object.values(ROLE_TABS).flat()));
const VALID_ROLES = Object.keys(RANKS);

function normalizeRole(role) {
  if (!role) return role;
  return LEGACY_ROLE_ALIASES[role] || role;
}

/**
 * Which built-in rank's defaults a role gets. Built-ins (and legacy
 * aliases) map to themselves. A custom Passport rank is placed by the
 * permissionLevel Passport reports for it (same thresholds as the stock
 * ranks: Sysadmin 200, ElevatedAdmins 50) — and anything unknown, with
 * no level to go on, falls back to StaffUsers, never upward.
 */
function accessTier(role, rank) {
  const r = normalizeRole(role);
  if (ROLE_TABS[r]) return r;
  const level = rank && Number.isFinite(rank.permissionLevel) ? rank.permissionLevel : -1;
  if (level >= 200) return 'systemAdministrator';
  if (level >= 50) return 'elevatedStaff';
  return 'staff';
}

function isFullAccess(role, rank) {
  return !!RANKS[accessTier(role, rank)].fullAccess;
}

/** Display info for a rank — Passport's own label/color when it sent them, else our built-in table. */
function rankInfo(role, rank) {
  const r = normalizeRole(role);
  const builtin = RANKS[r];
  return {
    name: r || null,
    label: (rank && rank.label) || (builtin && builtin.label) || r || 'Unknown',
    color: (rank && rank.color) || (builtin && builtin.color) || RANKS[accessTier(role, rank)].color,
    tier: accessTier(role, rank),
  };
}

function effectivePermissions(user) {
  const tier = accessTier(user.role, user.rank);
  const baseTabs = new Set(ROLE_TABS[tier]);
  const extra = (user.permissions && Array.isArray(user.permissions.extraTabs)) ? user.permissions.extraTabs : [];
  extra.forEach((t) => { if (ALL_TABS.includes(t)) baseTabs.add(t); });

  const basePower = !!ROLE_POWER_ACTIONS[tier];
  const extraPower = !!(user.permissions && user.permissions.powerActions);

  return {
    tabs: Array.from(baseTabs),
    powerActions: basePower || extraPower,
  };
}

module.exports = {
  RANKS, LEGACY_ROLE_ALIASES, VALID_ROLES, ROLE_TABS, ROLE_POWER_ACTIONS, ALL_TABS,
  normalizeRole, accessTier, isFullAccess, rankInfo, effectivePermissions,
};
