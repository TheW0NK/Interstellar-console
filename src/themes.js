'use strict';

/**
 * Every theme id this panel can render — the same set Passport (formerly
 * GAM / GUS) stores on a user's profile, so a theme picked in either app
 * shows up identically in the other. Keep in sync with Passport's own
 * THEMES list (public/index.html, and /api/v1/update-profile's allowlist)
 * and with the [data-theme] blocks in public/index.html here.
 *
 * DEFAULT_THEME is only for LOCAL accounts and Passport profiles that
 * somehow carry no theme at all — a Passport account's own theme always
 * wins (Passport defaults new accounts to blueSharp).
 */
const THEMES = ['ember', 'ocean', 'forest', 'light', 'purple', 'blueSharp', 'purpleSharp'];
const DEFAULT_THEME = 'ember';

function isValidTheme(theme) {
  return typeof theme === 'string' && THEMES.includes(theme);
}

/** Legacy 'sharp' was renamed to 'blueSharp' in Passport — carry it forward the same way. */
function normalizeTheme(theme) {
  if (theme === 'sharp') return 'blueSharp';
  return isValidTheme(theme) ? theme : DEFAULT_THEME;
}

module.exports = { THEMES, DEFAULT_THEME, isValidTheme, normalizeTheme };
