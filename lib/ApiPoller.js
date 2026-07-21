'use strict';
const HikAxPro = require('./HikAxPro');

/**
 * One poller per panel host. Logs in ONCE, reuses the session, polls zone,
 * subsystem, peripheral and host status on an interval and notifies subscribers.
 * Re-logs in on error. This is the fix for the AX PRO "too many sessions wedges
 * the panel" problem: every Homey device for a panel shares this single session.
 *
 * It also owns the real-time alertStream: alarm events (incl. PIR-CAM snapshots)
 * are pushed to alarm-subscribers as they happen.
 */
class ApiPoller {
  constructor({ host, username, password, interval = 5000 }) {
    this.api = new HikAxPro({ host, username, password });
    this.interval = interval;
    this._subs = new Set();       // status subscribers (polled state)
    this._alarmSubs = new Set();   // alarm-event subscribers (alertStream push)
    this._timer = null;
    this._stream = null;
    this._loggedIn = false;
    this._busy = false;
    this._failCount = 0;    // consecutive poll failures (drives backoff)
    this._nextAllowed = 0;  // earliest timestamp the next poll may run
    this.latest = { zones: {}, subSystems: {}, exDev: {}, host: {} };
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  onAlarm(fn) { this._alarmSubs.add(fn); return () => this._alarmSubs.delete(fn); }
  hasSubscribers() { return this._subs.size > 0 || this._alarmSubs.size > 0; }

  async _ensureLogin() {
    if (this._loggedIn) return;
    await this.api.login();
    this._loggedIn = true;
    this._openStream();
  }

  async pollOnce() {
    if (this._busy) return; // a slow previous poll is still running — don't overlap
    if (Date.now() < this._nextAllowed) return; // backing off after consecutive failures
    this._busy = true;
    try {
      await this._ensureLogin();
      const [z, s, ex, h] = await Promise.all([
        this.api.zoneStatus(),
        this.api.subSystems().catch(() => null),
        this.api.exDevStatus().catch(() => null),
        this.api.hostStatus().catch(() => null),
      ]);
      const zones = {};
      for (const it of (z.ZoneList || [])) zones[it.Zone.id] = it.Zone;
      const subs = {};
      if (s && s.SubSysList) for (const it of s.SubSysList) subs[it.SubSys.id] = it.SubSys;
      const host = (h && (h.AlarmHostStatus ? h.AlarmHostStatus.HostStatus : h.HostStatus)) || {};
      this.latest = { zones, subSystems: subs, exDev: (ex && ex.ExDevStatus) || {}, host };
      this._openStream(); // reopen the alertStream if the panel dropped it
      this._failCount = 0; // healthy again — clear any backoff
      this._nextAllowed = 0;
      for (const fn of this._subs) { try { fn(this.latest); } catch (e) {} }
    } catch (e) {
      // Best-effort close of the old panel session (we still hold its cookie)
      // so failed cycles don't stack sessions — the AX PRO wedges on that.
      await this.api.logout().catch(() => {});
      this._loggedIn = false; // force re-login next cycle
      this._closeStream();
      // Exponential backoff on consecutive failures: 30s -> 60s -> 5m -> 15m cap.
      // Retrying every tick forever floods the panel with logins and can lock it.
      this._failCount += 1;
      const delays = [30000, 60000, 300000, 900000];
      this._nextAllowed = Date.now() + delays[Math.min(this._failCount - 1, delays.length - 1)];
      throw e;
    } finally {
      this._busy = false;
    }
  }

  /** Apply new credentials/host (repair flow) and force a fresh login. */
  updateCredentials({ host, username, password }) {
    this._closeStream();
    this._loggedIn = false;
    this._failCount = 0;   // fresh credentials — retry immediately
    this._nextAllowed = 0;
    this.api.cookie = null;
    if (host) this.api.host = host;
    if (username) this.api.username = username;
    if (password) this.api.password = password;
  }

  _openStream() {
    if (this._stream || this._alarmSubs.size === 0) return;
    try {
      const req = this.api.openAlertStream(
        (evt) => { for (const fn of this._alarmSubs) { try { fn(evt); } catch (e) {} } },
        () => { if (this._stream === req) this._stream = null; }, // panel closed it — next poll reopens
      );
      this._stream = req;
    } catch (e) { this._stream = null; }
  }

  _closeStream() {
    if (this._stream) { try { this._stream.destroy(); } catch (e) {} this._stream = null; }
  }

  start() {
    if (this._timer) return;
    const tick = async () => { try { await this.pollOnce(); } catch (e) {} };
    tick();
    this._timer = setInterval(tick, this.interval);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._closeStream();
    if (this._loggedIn) { // free the panel session (AX PRO wedges on session exhaustion)
      this._loggedIn = false;
      this.api.logout().catch(() => {});
    }
  }
}

module.exports = ApiPoller;
