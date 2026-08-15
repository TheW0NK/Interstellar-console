'use strict';

/**
 * Checks github.com/TheW0NK/Interstellar-console for a newer release than
 * what's in branding.yml's `version` field. Release names are expected in
 * the form "Interstellar console x.y.z" (that's what the repo actually
 * uses — confirmed against the live API, not assumed).
 *
 * Fails open: any network error, rate limit, or malformed response just
 * means "no update info available" — this must never block or slow down
 * login.
 */
const RELEASES_URL = 'https://api.github.com/repos/TheW0NK/Interstellar-console/releases';
const VERSION_RE = /Interstellar console\s+(\d+)\.(\d+)\.(\d+)/i;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function parseVersion(str) {
  const m = String(str || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

class UpdateChecker {
  constructor({ includePrereleases = false, checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS } = {}) {
    this.includePrereleases = includePrereleases;
    this.checkIntervalMs = checkIntervalMs;
    this._cache = null; // { checkedAt, latest }
  }

  async _fetchLatestFromGitHub() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let res;
    try {
      res = await fetch(RELEASES_URL, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Interstellar-Console-UpdateChecker' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error('GitHub API returned ' + res.status);
    const releases = await res.json();
    if (!Array.isArray(releases)) throw new Error('Unexpected GitHub API response');

    let best = null;
    for (const r of releases) {
      if (r.draft) continue;
      if (r.prerelease && !this.includePrereleases) continue;
      const m = (r.name || '').match(VERSION_RE);
      if (!m) continue;
      const version = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
      if (!best || compareVersions(version, best.version) > 0) {
        best = { version, name: r.name, url: r.html_url };
      }
    }
    return best; // may be null if nothing matched
  }

  /**
   * Returns { available, currentVersion, latestVersion, url } or null if
   * no check has ever succeeded (never throws).
   */
  async check(currentVersionStr) {
    const now = Date.now();
    const stale = !this._cache || now - this._cache.checkedAt >= this.checkIntervalMs;
    if (stale) {
      try {
        const latest = await this._fetchLatestFromGitHub();
        this._cache = { checkedAt: now, latest };
      } catch (err) {
        // Keep serving the last good result, if any, rather than erroring.
        if (!this._cache) return null;
      }
    }
    const latest = this._cache && this._cache.latest;
    if (!latest) return null;

    const current = parseVersion(currentVersionStr) || [0, 0, 0];
    return {
      available: compareVersions(latest.version, current) > 0,
      currentVersion: currentVersionStr || '0.0.0',
      latestVersion: latest.version.join('.'),
      releaseName: latest.name,
      url: latest.url,
    };
  }
}

module.exports = { UpdateChecker, compareVersions, parseVersion };
