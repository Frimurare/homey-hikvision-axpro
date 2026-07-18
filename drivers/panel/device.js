'use strict';
const Homey = require('homey');

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
    if (this._poller.latest) await this._update(this._poller.latest).catch(this.error);
  }

  async _update(data) {
    if (this._type === 'panel') {
      const subs = Object.values(data.subSystems || {});
      let state = 'disarmed';
      if (subs.some((s) => s.arming === 'away')) state = 'armed';
      else if (subs.some((s) => s.arming === 'stay')) state = 'partially_armed';
      await this.setCapabilityValue('homealarm_state', state).catch(() => {});
      return;
    }
    const { zoneId } = this.getData();
    const Z = (data.zones || {})[zoneId];
    if (!Z) { await this.setUnavailable('Offline').catch(() => {}); return; }
    await this.setAvailable().catch(() => {});
    const set = (cap, val) => this.hasCapability(cap) && this.setCapabilityValue(cap, val).catch(() => {});
    if (Z.temperature !== undefined) set('measure_temperature', Z.temperature);
    if (Z.chargeValue !== undefined) set('measure_battery', Z.chargeValue);
    set('alarm_tamper', !!Z.tamperEvident);
    if ('magnetOpenStatus' in Z) set('alarm_contact', !!Z.magnetOpenStatus);
    set('alarm_motion', !!Z.alarm);
    set('alarm_smoke', !!Z.alarm);
  }

  async onDeleted() {
    if (this._unsub) this._unsub();
    this.homey.app.releasePoller(this._host);
  }
}

module.exports = AxProDevice;
