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
  // 30 s default: alarms arrive in real time over alertStream, so polling only
  // refreshes status. A tighter interval hammers the embedded panel for nothing.
  constructor({ host, username, password, interval = 30000, log = null, appVersion = '?' }) {
    this.api = new HikAxPro({ host, username, password });
    this.appVersion = appVersion;
    this.interval = interval;
    this._log = typeof log === 'function' ? log : () => {};
    this._diagDone = false;   // one-time, log-only field dump (diagnostic reports)
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
      if (!this._diagDone) { this._diagDone = true; await this._logDiagnostics(z, s, h); }
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

  /**
   * One-time diagnostic dump, log only, reusing the live session (never a
   * second login — the panel's session table is tiny). Field NAMES only, plus
   * model/firmware, so a Homey diagnostic report is enough to debug a panel we
   * don't have. No values, names or credentials.
   */
  async _logDiagnostics(z, s, h) {
    try {
      const info = await this.api.deviceSummary();
      const zones = (z && z.ZoneList) || [];
      const types = [...new Set(zones.map((it) => it.Zone && it.Zone.detectorType).filter(Boolean))];
      const zoneFields = zones.length ? Object.keys(zones[0].Zone || {}) : [];
      const subs = (s && s.SubSysList) || [];
      const subFields = subs.length ? Object.keys(subs[0].SubSys || {}) : [];
      const hostFields = Object.keys((h && (h.AlarmHostStatus ? h.AlarmHostStatus.HostStatus : h.HostStatus)) || {});
      this._log(`[diag] panel model=${info.model} firmware=${info.firmware} ${info.build}`.trim());
      this._log(`[diag] login capabilities fields: ${this.api.capFields.join(',') || '?'}`);
      this._log(`[diag] zones=${zones.length} detectorTypes=${types.join(',')}`);
      this._log(`[diag] zone fields: ${zoneFields.join(',')}`);
      this._log(`[diag] areas=${subs.length} fields: ${subFields.join(',')}`);
      this._log(`[diag] host fields: ${hostFields.join(',')}`);
      this._log(`[diag] app=${this.appVersion} area ids: ${subs.map((it) => `${it.SubSys.id}${it.SubSys.enabled === false ? '(off)' : ''}`).join(',')}`);
      // siren control: which siren devices exist and what the SecurityCP
      // catalogue says (key NAMES mentioning siren/buzzer only — no values)
      const sirens = ((this.latest.exDev || {}).SirenList || []).map((it) => (it.Siren || {}).id).filter((x) => x != null);
      this._log(`[diag] sirens: ${sirens.length ? sirens.join(',') : 'none listed'}`);
      try {
        const caps = await this.api.securityCpCaps();
        const keys = [];
        const walk = (o, path) => {
          if (!o || typeof o !== 'object') return;
          for (const [k, v] of Object.entries(o)) {
            const p = path ? `${path}.${k}` : k;
            if (/siren|buzzer|alarmOutput/i.test(k)) keys.push(typeof v === 'object' ? p : `${p}=${v}`);
            walk(v, p);
          }
        };
        walk(caps, '');
        this._log(`[diag] SecurityCP caps (siren-related): ${keys.slice(0, 30).join(' ') || 'none'}`);
      } catch (e) {
        this._log(`[diag] SecurityCP caps: unavailable (${e.message})`);
      }
    } catch (e) { /* diagnostics must never break polling */ }
  }

  /** Homey homealarm_state value -> panel mode. */
  static modeFor(value) {
    if (value === 'armed' || value === 'away') return 'away';
    if (value === 'partially_armed' || value === 'stay') return 'stay';
    return 'disarm';
  }

  /**
   * Current area status read straight from the panel (one GET on the shared
   * session — never a second login), so a command is decided on the real state
   * and not on a poll that may be up to 30 s old. Falls back to the last poll.
   */
  async _freshAreas() {
    try {
      await this._ensureLogin();
      const s = await this.api.subSystems();
      const subs = {};
      if (s && s.SubSysList) for (const it of s.SubSysList) subs[it.SubSys.id] = it.SubSys;
      if (Object.keys(subs).length) this.latest = { ...this.latest, subSystems: subs };
      return subs;
    } catch (e) {
      return this.latest.subSystems || {};
    }
  }

  _cmdLog(source, what, extra = '') {
    this._log(`[cmd] app=${this.appVersion} source=${source} ${what}${extra ? ` ${extra}` : ''}`);
  }

  _onControlError(e, source, what, current) {
    // a control failure is not a dead session — but 401 means it is
    if (e.code === 401) { this._loggedIn = false; this._closeStream(); }
    this._cmdLog(source, what, `current=${current} FAILED ${e.method || 'PUT'} ${e.url || ''} -> ${e.panelCode || e.code}`
      + ` ${e.reason || ''} panel=${e.body || ''}`);
  }

  /**
   * THE single arm/disarm path for one area — used by the area device, the
   * flow cards and (per area) the panel device, so they can never behave
   * differently again. mode: 'away' | 'stay' | 'disarm'.
   *
   * - Already in the requested mode -> nothing is sent (the panel answers a
   *   repeated arm with 400 "armedStatus"; field report 2026-10-18).
   * - 400 "armedStatus" -> the state is read back: if the requested mode now
   *   holds it is success, otherwise a clear AREA_STATE error with the
   *   current mode. A refusal is never reported as success unverified, and the
   *   area is never disarmed behind the user's back to "make room".
   * Returns 'sent' | 'already'.
   */
  async setArea(areaId, mode, source = 'device') {
    const id = String(areaId);
    const name = (A) => (A && A.name) || `area ${id}`;
    let subs = await this._freshAreas();
    let current = subs[id] ? HikAxPro.modeOf(subs[id]) : 'unknown';
    const what = `area=${id} want=${mode}`;
    if (current === mode) {
      this._cmdLog(source, what, `current=${current} -> already, nothing sent`);
      this.refreshSoon();
      return 'already';
    }
    const fn = mode === 'away' ? 'armAway' : (mode === 'stay' ? 'armStay' : 'disarm');
    try {
      await this.api[fn](id);
    } catch (e) {
      this._onControlError(e, source, what, current);
      if (e.code === 400 && /armedStatus/i.test(e.reason || '')) {
        subs = await this._freshAreas();
        const now = subs[id] ? HikAxPro.modeOf(subs[id]) : 'unknown';
        if (now === mode) {
          this._cmdLog(source, what, `panel said armedStatus but area is ${now} -> success (verified)`);
          this.refreshSoon();
          return 'already';
        }
        const err = new Error(`${name(subs[id])} is ${now}; the panel refused "${mode}" (400 armedStatus)`);
        err.code = 'AREA_STATE'; err.area = name(subs[id]); err.current = now; err.want = mode;
        err.panelCode = 400; err.reason = e.reason; err.url = e.url; err.body = e.body;
        throw err;
      }
      throw e;
    }
    this._cmdLog(source, what, `current=${current} -> sent OK`);
    this.refreshSoon();
    return 'sent';
  }

  /**
   * Arm/disarm the whole system: 'armed' | 'partially_armed' | 'disarmed'.
   * Nothing is sent when every enabled area already is in that mode. Uses the
   * 0xffffffff wildcard, falling back to per-area commands when the panel
   * rejects the wildcard; a 400 "armedStatus" is verified against the read-back
   * state like setArea().
   */
  async armAll(value, source = 'device') {
    const mode = ApiPoller.modeFor(value);
    let subs = await this._freshAreas();
    const enabled = () => Object.values(subs).filter((a) => a && a.enabled !== false);
    const allIn = (m) => enabled().length > 0 && enabled().every((a) => HikAxPro.modeOf(a) === m);
    const current = [...new Set(enabled().map((a) => HikAxPro.modeOf(a)))].join('/') || 'unknown';
    const what = `area=all want=${mode}`;
    if (allIn(mode)) {
      this._cmdLog(source, what, `current=${current} -> already, nothing sent`);
      this.refreshSoon();
      return 'already';
    }
    try {
      await this.api.armAll(mode, enabled().map((a) => a.id));
    } catch (e) {
      this._onControlError(e, source, what, current);
      if (e.code === 400 && /armedStatus/i.test(e.reason || '')) {
        subs = await this._freshAreas();
        if (allIn(mode)) { this.refreshSoon(); return 'already'; }
        const now = [...new Set(enabled().map((a) => HikAxPro.modeOf(a)))].join('/') || 'unknown';
        const err = new Error(`The system is ${now}; the panel refused "${mode}" (400 armedStatus)`);
        err.code = 'AREA_STATE'; err.area = '*'; err.current = now; err.want = mode;
        err.panelCode = 400; err.reason = e.reason; err.url = e.url; err.body = e.body;
        throw err;
      }
      throw e;
    }
    this._cmdLog(source, what, `current=${current} -> sent OK`);
    this.refreshSoon();
    return 'sent';
  }

  /** Siren on/off with the same logging; SIREN_NOT_SUPPORTED passes through. */
  async siren(on, source = 'flow') {
    const what = `siren=${on ? 'test(on)' : 'stop(off)'}`;
    try {
      await this._ensureLogin();
      await this.api.sirenTest(on);
    } catch (e) {
      this._onControlError(e, source, what, '-');
      throw e;
    }
    this._cmdLog(source, what, '-> sent OK');
    return 'sent';
  }

  /** Poll once shortly after a control command (arm/disarm/bypass). */
  refreshSoon(delay = 1500) {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.pollOnce().catch(() => {});
    }, delay);
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
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this._closeStream();
    if (this._loggedIn) { // free the panel session (AX PRO wedges on session exhaustion)
      this._loggedIn = false;
      this.api.logout().catch(() => {});
    }
  }
}

module.exports = ApiPoller;
