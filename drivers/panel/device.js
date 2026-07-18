'use strict';
const Homey = require('homey');

// device type -> exDevStatus list/item names
const PERIPHERAL_MAP = {
  keypad:     { list: 'KeypadList',     item: 'Keypad' },
  siren:      { list: 'SirenList',      item: 'Siren' },
  repeater:   { list: 'RepeaterList',   item: 'Repeater' },
  cardreader: { list: 'CardReaderList', item: 'CardReader' },
  output:     { list: 'OutputList',     item: 'Output' },
};

class AxProDevice extends Homey.Device {
  async onInit() {
    const { host, type } = this.getData();
    const { username, password } = this.getStore();
    this._type = type;
    this._host = host;
    this._poller = this.homey.app.getPoller({ host, username, password });
    this._unsub = this._poller.subscribe((data) => this._update(data).catch(this.error));

    if (type === 'panel') {
      this.registerCapabilityListener('homealarm_state', async (value) => {
        const api = this._poller.api;
        if (value === 'armed') await api.armAway();
        else if (value === 'partially_armed') await api.armStay();
        else await api.disarm();
      });
    }
    if (type === 'output') {
      this.registerCapabilityListener('onoff', async (value) => {
        const { devId } = this.getData();
        await this._poller.api.setOutput(devId, value);
      });
    }
    if (this._poller.latest) await this._update(this._poller.latest).catch(this.error);
  }

  _set(cap, val) { return this.hasCapability(cap) && this.setCapabilityValue(cap, val).catch(() => {}); }

  async _update(data) {
    if (this._type === 'panel') {
      const subs = Object.values(data.subSystems || {});
      let state = 'disarmed';
      if (subs.some((s) => s.arming === 'away')) state = 'armed';
      else if (subs.some((s) => s.arming === 'stay')) state = 'partially_armed';
      await this._set('homealarm_state', state);
      return;
    }

    if (this._type === 'zone') {
      const { zoneId } = this.getData();
      const Z = (data.zones || {})[zoneId];
      if (!Z) { await this.setUnavailable('Offline').catch(() => {}); return; }
      await this.setAvailable().catch(() => {});
      if (Z.temperature !== undefined) this._set('measure_temperature', Z.temperature);
      if (Z.chargeValue !== undefined) this._set('measure_battery', Z.chargeValue);
      this._set('alarm_tamper', !!Z.tamperEvident);
      const triggered = !!Z.alarm;
      // contact uses the magnet state directly; everything else follows the alarm flag
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
    const { devId } = this.getData();
    const list = (data.exDev || {})[map.list] || [];
    const rec = list.map((it) => it[map.item] || Object.values(it)[0]).find((d) => d && d.id === devId);
    if (!rec) { await this.setUnavailable('Offline').catch(() => {}); return; }
    await this.setAvailable().catch(() => {});
    if (rec.temperature !== undefined) this._set('measure_temperature', rec.temperature);
    if (rec.chargeValue !== undefined) this._set('measure_battery', rec.chargeValue);
    this._set('alarm_tamper', !!rec.tamperEvident);
    if (this._type === 'output') this._set('onoff', !!(rec.enabled || rec.output || rec.on));
  }

  async onDeleted() {
    if (this._unsub) this._unsub();
    this.homey.app.releasePoller(this._host);
  }
}

module.exports = AxProDevice;
