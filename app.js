'use strict';
const Homey = require('homey');
const ApiPoller = require('./lib/ApiPoller');

class HikAxProApp extends Homey.App {
  async onInit() {
    this._pollers = new Map();   // host -> ApiPoller
    this._prev = new Map();      // host -> { armed, zoneAlarms:Set }
    this._snaps = new Map();     // `${host}:${zoneId}` / `${host}:last` -> Buffer
    await this._registerFlow();
    this.log('Hikvision AX PRO app started');
  }

  // ---- pollers ---------------------------------------------------------------

  getPoller({ host, username, password }) {
    if (!this._pollers.has(host)) {
      const p = new ApiPoller({ host, username, password });
      this._pollers.set(host, p);
      this._prev.set(host, { armed: null, zoneAlarms: new Set() });
      p.subscribe((data) => this._onStatus(host, data));
      p.onAlarm((evt) => this._onAlarm(host, evt));
      p.start();
    }
    return this._pollers.get(host);
  }

  releasePoller(host) {
    const p = this._pollers.get(host);
    if (p && !p.hasSubscribers()) { p.stop(); this._pollers.delete(host); this._prev.delete(host); }
  }

  _anyPoller() { return this._pollers.values().next().value || null; }
  _pollerFor(pred) {
    for (const p of this._pollers.values()) if (pred(p)) return p;
    return this._anyPoller();
  }

  // ---- snapshots (PIR-CAM) ---------------------------------------------------

  getSnapshot(host, zoneId) {
    return this._snaps.get(`${host}:${zoneId}`) || this._snaps.get(`${host}:last`) || null;
  }

  _onAlarm(host, evt) {
    if (!evt || !evt.image) return;
    this._snaps.set(`${host}:last`, evt.image);
    // best-effort: key by zone id if the event carries one (payload verified with real alarm)
    const j = evt.json || {};
    const zid = (j.zoneID != null) ? j.zoneID : (j.id != null ? j.id
      : (j.EventNotificationAlert && j.EventNotificationAlert.zoneID));
    if (zid !== undefined && zid !== null) this._snaps.set(`${host}:${zid}`, evt.image);
  }

  // ---- status edges -> triggers ----------------------------------------------

  _onStatus(host, data) {
    const prev = this._prev.get(host) || { armed: null, zoneAlarms: new Set() };
    // system armed/disarmed
    const subs = Object.values(data.subSystems || {});
    const armed = subs.some((s) => String(s.arming || '').toLowerCase() !== 'disarm');
    if (prev.armed !== null && armed !== prev.armed) {
      const mode = subs.find((s) => String(s.arming || '').toLowerCase() !== 'disarm');
      if (armed) this._trArmed.trigger({ mode: mode ? String(mode.arming) : 'away' }).catch(() => {});
      else this._trDisarmed.trigger({}).catch(() => {});
    }
    // per-zone alarm edges
    const now = new Set();
    for (const Z of Object.values(data.zones || {})) {
      if (Z.alarm) {
        now.add(Z.id);
        if (!prev.zoneAlarms.has(Z.id)) {
          this._lastBuf = this.getSnapshot(host, Z.id);
          this._trDetector.trigger(
            { name: Z.name || `Zone ${Z.id}`, type: Z.detectorType || '', area: Z.subSystemNo || 1, snapshot: this._alarmImage },
          ).catch(() => {});
        }
      }
    }
    this._prev.set(host, { armed, zoneAlarms: now });
  }

  // ---- flow cards ------------------------------------------------------------

  async _registerFlow() {
    // shared image token that streams the most recently fired snapshot
    this._alarmImage = await this.homey.images.createImage();
    this._alarmImage.setStream(async (stream) => {
      if (!this._lastBuf) throw new Error('no snapshot');
      stream.end(this._lastBuf);
    });

    this._trDetector = this.homey.flow.getTriggerCard('detector_alarmed');
    this._trArmed = this.homey.flow.getTriggerCard('system_armed');
    this._trDisarmed = this.homey.flow.getTriggerCard('system_disarmed');

    // conditions
    this.homey.flow.getConditionCard('system_is_armed').registerRunListener(() => {
      const p = this._anyPoller();
      const subs = p ? Object.values(p.latest.subSystems || {}) : [];
      return subs.some((s) => String(s.arming || '').toLowerCase() !== 'disarm');
    });
    const areaCond = this.homey.flow.getConditionCard('area_is_armed');
    areaCond.registerArgumentAutocompleteListener('area', (q) => this._areaAutocomplete(q));
    areaCond.registerRunListener((args) => {
      const p = this._anyPoller();
      const A = p && p.latest.subSystems ? p.latest.subSystems[args.area.id] : null;
      return !!A && String(A.arming || '').toLowerCase() !== 'disarm';
    });

    // actions
    const armArea = this.homey.flow.getActionCard('arm_area');
    armArea.registerArgumentAutocompleteListener('area', (q) => this._areaAutocomplete(q));
    armArea.registerRunListener(async (args) => {
      const p = this._pollerHavingArea(args.area.id);
      if (!p) throw new Error('panel not connected');
      if (args.mode === 'stay') await p.api.armStay(String(args.area.id));
      else await p.api.armAway(String(args.area.id));
      return true;
    });
    const disarmArea = this.homey.flow.getActionCard('disarm_area');
    disarmArea.registerArgumentAutocompleteListener('area', (q) => this._areaAutocomplete(q));
    disarmArea.registerRunListener(async (args) => {
      const p = this._pollerHavingArea(args.area.id);
      if (!p) throw new Error('panel not connected');
      await p.api.disarm(String(args.area.id));
      return true;
    });
    const bypass = this.homey.flow.getActionCard('bypass_zone');
    bypass.registerArgumentAutocompleteListener('zone', (q) => this._zoneAutocomplete(q));
    bypass.registerRunListener(async (args) => {
      const p = this._pollerHavingZone(args.zone.id);
      if (!p) throw new Error('panel not connected');
      await p.api.bypassZone(args.zone.id, args.state === 'bypass');
      return true;
    });
    this.homey.flow.getActionCard('siren').registerRunListener(async (args) => {
      const p = this._anyPoller();
      if (!p) throw new Error('panel not connected');
      await p.api.sirenTest(args.state === 'on');
      return true;
    });
  }

  _areaAutocomplete(query) {
    const out = [];
    for (const p of this._pollers.values())
      for (const A of Object.values(p.latest.subSystems || {}))
        if (A.enabled !== false) out.push({ name: A.name || `Area ${A.id}`, id: A.id });
    return this._filter(out, query);
  }

  _zoneAutocomplete(query) {
    const out = [];
    for (const p of this._pollers.values())
      for (const Z of Object.values(p.latest.zones || {}))
        out.push({ name: Z.name || `Zone ${Z.id}`, id: Z.id });
    return this._filter(out, query);
  }

  _filter(items, query) {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }

  _pollerHavingArea(id) { return this._pollerFor((p) => p.latest.subSystems && id in p.latest.subSystems); }
  _pollerHavingZone(id) { return this._pollerFor((p) => p.latest.zones && id in p.latest.zones); }
}

module.exports = HikAxProApp;
