'use strict';
const Homey = require('homey');
const ApiPoller = require('./lib/ApiPoller');

// Single interpretation of the panel's "arming" value, shared by every flow
// card and status edge. Anything that isn't explicitly away/stay counts as
// DISARMED (fail-safe): a missing/unknown value must never read as "armed".
const armState = (arming) => {
  const a = String(arming || '').toLowerCase();
  if (a.includes('away')) return 'armed';
  if (a.includes('stay')) return 'partially_armed';
  return 'disarmed';
};
const isArmed = (s) => armState(s.arming) !== 'disarmed';
const enabledSubs = (subSystems) =>
  Object.values(subSystems || {}).filter((s) => s.enabled !== false);

// How long a per-trigger snapshot image stays registered (flows have consumed
// it long before this).
const SNAPSHOT_IMAGE_TTL_MS = 5 * 60 * 1000;

class HikAxProApp extends Homey.App {
  async onInit() {
    this._pollers = new Map();   // host -> ApiPoller
    this._refs = new Map();      // host -> number of devices using the poller
    this._unsubs = new Map();    // host -> [app-owned unsubscribe fns]
    this._prev = new Map();      // host -> { firstPoll, armed, zoneAlarms:Set }
    this._snaps = new Map();     // `${host}:${zoneId}` / `${host}:last` -> Buffer
    await this._registerFlow();
    this.log('Hikvision AX PRO app started');
  }

  // ---- pollers ---------------------------------------------------------------

  getPoller({ host, username, password }) {
    this._refs.set(host, (this._refs.get(host) || 0) + 1);
    if (!this._pollers.has(host)) {
      const p = new ApiPoller({ host, username, password });
      this._pollers.set(host, p);
      this._prev.set(host, { firstPoll: true, armed: false, zoneAlarms: new Set() });
      // keep the unsubscribe fns so releasePoller() can actually release
      const u1 = p.subscribe((data) => this._onStatus(host, data));
      const u2 = p.onAlarm((evt) => this._onAlarm(host, evt));
      this._unsubs.set(host, [u1, u2]);
      p.start();
    }
    return this._pollers.get(host);
  }

  releasePoller(host) {
    const n = (this._refs.get(host) || 1) - 1;
    if (n > 0) { this._refs.set(host, n); return; }
    this._refs.delete(host);
    for (const u of (this._unsubs.get(host) || [])) {
      try { u(); } catch (e) { /* ignore */ }
    }
    this._unsubs.delete(host);
    const p = this._pollers.get(host);
    if (p) { p.stop(); this._pollers.delete(host); }
    this._prev.delete(host);
  }

  /** Repair changed the credentials (and possibly the IP): apply them to the
   *  running poller so devices keep working without an app restart, instead of
   *  hammering the panel with the old password (account lockout). */
  updatePollerCredentials(oldHost, { host, username, password }) {
    const p = this._pollers.get(oldHost);
    if (!p) return;
    p.api.host = host;
    p.api.username = username;
    p.api.password = password;
    p._loggedIn = false;
    // best-effort: drop the old session so the next tick logs in fresh
    p.api.logout().catch(() => {});
    if (host !== oldHost) {
      for (const m of [this._pollers, this._refs, this._unsubs, this._prev]) {
        if (m.has(oldHost)) { m.set(host, m.get(oldHost)); m.delete(oldHost); }
      }
    }
  }

  async onUninit() {
    for (const us of this._unsubs.values()) {
      for (const u of us) { try { u(); } catch (e) { /* ignore */ } }
    }
    this._unsubs.clear();
    for (const p of this._pollers.values()) p.stop();
    this._pollers.clear();
    this._refs.clear();
    this._prev.clear();
  }

  _anyPoller() { return this._pollers.values().next().value || null; }
  _pollerFor(pred) {
    for (const p of this._pollers.values()) if (pred(p)) return p;
    return null; // never fall back to another panel: wrong-panel arm/disarm is worse than an error
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
    const prev = this._prev.get(host)
      || { firstPoll: true, armed: false, zoneAlarms: new Set() };
    const subs = enabledSubs(data.subSystems);
    const armed = subs.some(isArmed);
    const now = new Set();
    for (const Z of Object.values(data.zones || {})) if (Z.alarm) now.add(Z.id);

    // On the very first poll for a host (app start / first device added) we only
    // record the state — firing edges here would re-trigger flows for a state
    // that existed before we started (e.g. re-siren an already-alarming zone).
    if (!prev.firstPoll) {
      if (armed !== prev.armed) {
        if (armed) {
          const mode = subs.find(isArmed);
          this._trArmed.trigger({ mode: mode ? String(mode.arming) : 'away' }).catch(() => {});
        } else {
          this._trDisarmed.trigger({}).catch(() => {});
        }
      }
      for (const Z of Object.values(data.zones || {})) {
        if (Z.alarm && !prev.zoneAlarms.has(Z.id)) {
          this._triggerDetector(host, Z).catch(this.error);
        }
      }
    }

    this._prev.set(host, { firstPoll: false, armed, zoneAlarms: now });
  }

  /** Fire detector_alarmed with a per-trigger snapshot image. The buffer is
   *  captured in a closure at trigger time, so two zones alarming in the same
   *  poll each get their own picture, and a delayed flow still shows the right
   *  one. The snapshot token is only included when a picture actually exists. */
  async _triggerDetector(host, Z) {
    const tokens = { name: Z.name || `Zone ${Z.id}`, type: Z.detectorType || '', area: Z.subSystemNo || 1 };
    const buf = this.getSnapshot(host, Z.id);
    if (buf) {
      try {
        const img = await this.homey.images.createImage();
        img.setStream(async (stream) => { stream.end(buf); });
        tokens.snapshot = img;
        this.homey.setTimeout(() => { img.unregister().catch(() => {}); }, SNAPSHOT_IMAGE_TTL_MS);
      } catch (e) {
        // fall through: trigger without a snapshot token
      }
    }
    await this._trDetector.trigger(tokens).catch(() => {});
  }

  // ---- flow cards ------------------------------------------------------------

  async _registerFlow() {
    this._trDetector = this.homey.flow.getTriggerCard('detector_alarmed');
    this._trArmed = this.homey.flow.getTriggerCard('system_armed');
    this._trDisarmed = this.homey.flow.getTriggerCard('system_disarmed');

    // conditions
    this.homey.flow.getConditionCard('system_is_armed').registerRunListener(() => {
      const p = this._pollerFor((x) => enabledSubs(x.latest.subSystems).some(isArmed));
      return !!p;
    });
    const areaCond = this.homey.flow.getConditionCard('area_is_armed');
    areaCond.registerArgumentAutocompleteListener('area', (q) => this._areaAutocomplete(q));
    areaCond.registerRunListener((args) => {
      const p = this._pollerHavingArea(args.area.id);
      const A = p && p.latest.subSystems ? p.latest.subSystems[args.area.id] : null;
      return !!A && A.enabled !== false && isArmed(A);
    });

    // actions
    const armArea = this.homey.flow.getActionCard('arm_area');
    armArea.registerArgumentAutocompleteListener('area', (q) => this._areaAutocomplete(q));
    armArea.registerRunListener(async (args) => {
      const p = this._pollerHavingArea(args.area.id);
      if (!p) throw new Error(`No connected panel has area "${args.area.name || args.area.id}"`);
      if (args.mode === 'stay') await p.api.armStay(String(args.area.id));
      else await p.api.armAway(String(args.area.id));
      return true;
    });
    const disarmArea = this.homey.flow.getActionCard('disarm_area');
    disarmArea.registerArgumentAutocompleteListener('area', (q) => this._areaAutocomplete(q));
    disarmArea.registerRunListener(async (args) => {
      const p = this._pollerHavingArea(args.area.id);
      if (!p) throw new Error(`No connected panel has area "${args.area.name || args.area.id}"`);
      await p.api.disarm(String(args.area.id));
      return true;
    });
    const bypass = this.homey.flow.getActionCard('bypass_zone');
    bypass.registerArgumentAutocompleteListener('zone', (q) => this._zoneAutocomplete(q));
    bypass.registerRunListener(async (args) => {
      const p = this._pollerHavingZone(args.zone.id);
      if (!p) throw new Error(`No connected panel has zone "${args.zone.name || args.zone.id}"`);
      await p.api.bypassZone(args.zone.id, args.state === 'bypass');
      return true;
    });
    this.homey.flow.getActionCard('siren').registerRunListener(async (args) => {
      const p = this._anyPoller();
      if (!p) throw new Error('No panel is connected');
      await p.api.sirenTest(args.state === 'on');
      return true;
    });
  }

  _areaAutocomplete(query) {
    const out = [];
    for (const p of this._pollers.values())
      for (const A of enabledSubs(p.latest.subSystems))
        out.push({ name: A.name || `Area ${A.id}`, id: A.id });
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
