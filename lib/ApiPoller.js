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
  constructor({ host, username, password, interval = 30000 }) {
    this.api = new HikAxPro({ host, username, password });
    this.interval = interval;
    this._subs = new Set();       // status subscribers (polled state)
    this._alarmSubs = new Set();   // alarm-event subscribers (alertStream push)
    this._timer = null;
    this._stream = null;
    this._loggedIn = false;
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
      for (const fn of this._subs) { try { fn(this.latest); } catch (e) {} }
    } catch (e) {
      this._loggedIn = false; // force re-login next cycle
      this._closeStream();
      throw e;
    }
  }

  _openStream() {
    if (this._stream || this._alarmSubs.size === 0) return;
    try {
      this._stream = this.api.openAlertStream((evt) => {
        for (const fn of this._alarmSubs) { try { fn(evt); } catch (e) {} }
      });
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
  }
}

module.exports = ApiPoller;
