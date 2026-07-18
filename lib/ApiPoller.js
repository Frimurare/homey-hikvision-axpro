'use strict';
const HikAxPro = require('./HikAxPro');

/**
 * One poller per panel host. Logs in ONCE, reuses the session, polls zone +
 * subsystem status on an interval and notifies subscribers. Re-logs in on error.
 * This is the fix for the AX PRO "too many sessions wedges the panel" problem:
 * every Homey device for a panel shares this single session.
 */
class ApiPoller {
  constructor({ host, username, password, interval = 30000 }) {
    this.api = new HikAxPro({ host, username, password });
    this.interval = interval;
    this._subs = new Set();
    this._timer = null;
    this._loggedIn = false;
    this.latest = { zones: {}, subSystems: {}, exDev: {} };
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  hasSubscribers() { return this._subs.size > 0; }

  async _ensureLogin() {
    if (this._loggedIn) return;
    await this.api.login();
    this._loggedIn = true;
  }

  async pollOnce() {
    try {
      await this._ensureLogin();
      const [z, s, ex] = await Promise.all([
        this.api.zoneStatus(),
        this.api.subSystems().catch(() => null),
        this.api.exDevStatus().catch(() => null),
      ]);
      const zones = {};
      for (const it of (z.ZoneList || [])) zones[it.Zone.id] = it.Zone;
      const subs = {};
      if (s && s.SubSysList) for (const it of s.SubSysList) subs[it.SubSys.id] = it.SubSys;
      this.latest = { zones, subSystems: subs, exDev: (ex && ex.ExDevStatus) || {} };
      for (const fn of this._subs) { try { fn(this.latest); } catch (e) {} }
    } catch (e) {
      this._loggedIn = false; // force re-login next cycle
      throw e;
    }
  }

  start() {
    if (this._timer) return;
    const tick = async () => { try { await this.pollOnce(); } catch (e) {} };
    tick();
    this._timer = setInterval(tick, this.interval);
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

module.exports = ApiPoller;
