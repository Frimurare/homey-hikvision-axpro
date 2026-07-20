'use strict';
const Homey = require('homey');
const { LOW_BATTERY } = require('../../lib/profiles');

// device type -> exDevStatus list/item names (fallback when data.list is absent)
const PERIPHERAL_MAP = {
  keypad:     { list: 'KeypadList',     item: 'Keypad' },
  siren:      { list: 'SirenList',      item: 'Siren' },
  repeater:   { list: 'RepeaterList',   item: 'Repeater' },
  cardreader: { list: 'CardReaderList', item: 'CardReader' },
  output:     { list: 'OutputList',     item: 'Output' },
};

// exDevStatus list name -> item wrapper name (data.list from discovery wins,
// so OutputMod devices resolve against OutputModList, not OutputList)
const ITEM_BY_LIST = {
  KeypadList:     'Keypad',
  SirenList:      'Siren',
  RepeaterList:   'Repeater',
  CardReaderList: 'CardReader',
  OutputList:     'Output',
  OutputModList:  'OutputMod',
};

class AxProDevice extends Homey.Device {
  async onInit() {
    const data = this.getData();
    const store = this.getStore();
    this._type = data.type;
    this._host = store.host || data.host; // store host wins (repair can change the IP)
    const { username, password } = store;
    this._poller = this.homey.app.getPoller({ host: this._host, username, password });
    this._unsub = this._poller.subscribe((d) => this._update(d).catch(this.error));

    // Panel: arm/disarm the whole system
    if (this._type === 'panel') {
      this.registerCapabilityListener('homealarm_state', (v) => this._setArm(v, '0xffffffff'));
    }
    // Area: arm/disarm just this partition
    if (this._type === 'area') {
      this.registerCapabilityListener('homealarm_state', (v) => this._setArm(v, String(data.areaId)));
    }
    // Output relay
    if (this._type === 'output') {
      this.registerCapabilityListener('onoff', (v) => this._poller.api.setOutput(data.devId, v));
    }
    // PIR-CAM detector: expose a camera image (last capture on alarm)
    if (this._type === 'zone' && store.cam) {
      this._img = await this.homey.images.createImage();
      this._img.setStream(async (stream) => {
        const buf = this.homey.app.getSnapshot(this._host, data.zoneId);
        if (!buf) throw new Error('no snapshot captured yet');
        stream.end(buf);
      });
      await this.setCameraImage('alarm', 'Alarm', this._img).catch(this.error);
    }

    if (this._poller.latest) await this._update(this._poller.latest).catch(this.error);
  }

  async _setArm(value, sub) {
    const api = this._poller.api;
    if (value === 'armed') await api.armAway(sub);
    else if (value === 'partially_armed') await api.armStay(sub);
    else await api.disarm(sub);
  }

  _set(cap, val) { return this.hasCapability(cap) && this.setCapabilityValue(cap, val).catch(() => {}); }

  _armState(sub) {
    const a = String(sub.arming || '').toLowerCase();
    if (a.includes('away')) return 'armed';
    if (a.includes('stay')) return 'partially_armed';
    return 'disarmed';
  }

  async _update(data) {
    // Before the first poll completes, poller.latest is a truthy-but-empty
    // object. Skip instead of flashing every device "Offline" on app start.
    const noData = Object.keys(data.zones || {}).length === 0
      && Object.keys(data.subSystems || {}).length === 0
      && Object.keys(data.exDev || {}).length === 0;
    if (noData) return;

    if (this._type === 'panel') {
      const subs = Object.values(data.subSystems || {});
      let state = 'disarmed';
      if (subs.some((s) => this._armState(s) === 'armed')) state = 'armed';
      else if (subs.some((s) => this._armState(s) === 'partially_armed')) state = 'partially_armed';
      this._set('homealarm_state', state);
      const h = data.host || {};
      this._set('alarm_tamper', !!h.tamperEvident);
      // ACConnect true = mains present; alarm when it is explicitly false
      if ('ACConnect' in h) this._set('alarm_mains', h.ACConnect === false);
      return;
    }

    if (this._type === 'area') {
      const { areaId } = this.getData();
      const A = (data.subSystems || {})[areaId];
      if (!A) { await this.setUnavailable('Offline').catch(() => {}); return; }
      await this.setAvailable().catch(() => {});
      this._set('homealarm_state', this._armState(A));
      return;
    }

    if (this._type === 'zone') {
      const { zoneId } = this.getData();
      const Z = (data.zones || {})[zoneId];
      if (!Z) { await this.setUnavailable('Offline').catch(() => {}); return; }
      await this.setAvailable().catch(() => {});
      if (Z.temperature !== undefined) this._set('measure_temperature', Z.temperature);
      if (Z.chargeValue !== undefined) {
        this._set('measure_battery', Z.chargeValue);
        this._set('alarm_battery', Z.chargeValue <= LOW_BATTERY);
      }
      this._set('alarm_tamper', !!Z.tamperEvident);
      const triggered = !!Z.alarm;
      if ('magnetOpenStatus' in Z) this._set('alarm_contact', !!Z.magnetOpenStatus);
      else this._set('alarm_contact', triggered);
      this._set('alarm_motion', triggered);
      this._set('alarm_smoke', triggered);
      this._set('alarm_water', triggered);
      this._set('alarm_co', triggered);
      this._set('alarm_co2', triggered);
      this._set('alarm_heat', triggered);
      this._set('alarm_generic', triggered);
      return;
    }

    // peripheral (keypad/siren/repeater/cardreader/output)
    const map = PERIPHERAL_MAP[this._type];
    if (!map) return;
    const { devId, list: dataList } = this.getData();
    const listName = dataList || map.list;
    const itemName = ITEM_BY_LIST[listName] || map.item;
    const list = (data.exDev || {})[listName] || [];
    const rec = list.map((it) => it[itemName] || Object.values(it)[0]).find((d) => d && d.id === devId);
    if (!rec) { await this.setUnavailable('Offline').catch(() => {}); return; }
    await this.setAvailable().catch(() => {});
    if (rec.temperature !== undefined) this._set('measure_temperature', rec.temperature);
    if (rec.chargeValue !== undefined) {
      this._set('measure_battery', rec.chargeValue);
      this._set('alarm_battery', rec.chargeValue <= LOW_BATTERY);
    }
    this._set('alarm_tamper', !!rec.tamperEvident);
    if (this._type === 'output') this._set('onoff', !!(rec.enabled || rec.output || rec.on));
  }

  async onDeleted() {
    if (this._unsub) this._unsub();
    if (this._img) await this._img.unregister().catch(() => {});
    this.homey.app.releasePoller(this._host);
  }
}

module.exports = AxProDevice;
