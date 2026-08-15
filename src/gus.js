'use strict';

const TIMEOUT_MS = 6000;

/**
 * Thin client for GUS's app-facing contract. Every method here maps
 * directly onto one endpoint from gus/README.md ("The app-facing
 * contract"). Nothing here interprets GUS's response beyond parsing
 * JSON — status mapping (good / good_change_pw / bad / disabled /
 * invalid_app / rate_limited) is the caller's job, since what to DO with
 * each status is app-specific (this file is meant to work unmodified even
 * if the exact login flow around it changes).
 */
class GusClient {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
  }

  async _post(path, body) {
    const settings = this.settingsStore.read();
    const url = `${settings.baseUrl.replace(/\/$/, '')}/api/v1${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Id': settings.appId,
          'X-App-Secret': settings.appSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const e = new Error('Could not reach GUS: ' + err.message);
      e.gusUnreachable = true;
      throw e;
    } finally {
      clearTimeout(timeout);
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* some responses (204-ish) may have no body */ }
    return { httpStatus: res.status, body: json || {} };
  }

  /** -> { httpStatus, body: {status, token?, user?, retryAfterSeconds?, error?} } */
  login(username, password) {
    return this._post('/login', { username, password });
  }

  /** -> { httpStatus, body: {valid, user?} } */
  validate(token) {
    return this._post('/validate', { token });
  }

  /** -> { httpStatus, body: {ok} } */
  logout(token) {
    return this._post('/logout', { token });
  }

  /** -> { httpStatus, body: {status, user?, error?} } */
  changePassword(token, { currentPassword, newPassword, confirmPassword }) {
    return this._post('/change-password', { token, currentPassword, newPassword, confirmPassword });
  }

  /** -> { httpStatus, body: {status, user?} } */
  updateProfile(token, { fullName, description, theme }) {
    return this._post('/update-profile', { token, fullName, description, theme });
  }
}

module.exports = { GusClient };
