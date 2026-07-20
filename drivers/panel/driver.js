'use strict';
const Homey = require('homey');
const HikAxPro = require('../../lib/HikAxPro');
const { zoneProfile, PERIPHERALS } = require('../../lib/profiles');

// Homey resolves the pairing `icon` path relative to /drivers/<id>/assets/,
// so it must be just "/name.svg" (NOT the full /drivers/... path).
const ICON = (name) => `/${name}.svg`;

class PanelDriver extends Homey.Driver {
  // credentials of an already-paired panel, if any (lets you add more detectors
  // later without re-entering the panel IP/login — feature H)
  _existingPanelCreds() {
    const panel = this.getDevices().find((d) => d.getData().type === 'panel');
    if (!panel) return null;
    const s = panel.getStore();
    return { host: s.host || panel.getData().host, username: s.username, password: s.password };
  }

  _existingIds() {
    return new Set(this.getDevices().map((d) => d.getData().id));
  }

  async onPair(session) {
    let creds = this._existingPanelCreds();

    // If a panel is already added, skip the login screen and go straight to the list.
    session.setHandler('showView', async (view) => {
      if (view === 'connect' && creds) {
        await session.showView('list_devices');
      }
    });

    session.setHandler('connect', async ({ host, username, password }) => {
      const api = new HikAxPro({ host, username, password });
      await api.login();           // throws on bad credentials -> shown in pair view
      await api.logout();
      creds = { host, username, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!creds) throw new Error('Not connected');
      const devices = await this._discover(creds);
      // Feature H: hide detectors that are already added (no duplicates).
      const existing = this._existingIds();
      return devices.filter((d) => !existing.has(d.data.id));
    });
  }

  // Feature F: repair an existing device — re-enter the panel IP/password without
  // removing it. Updates the stored credentials (and host, for an IP change).
  async onRepair(session, device) {
    session.setHandler('connect', async ({ host, username, password }) => {
      const api = new HikAxPro({ host, username, password });
      await api.login();
      await api.logout();
      // update every device on this panel so they all keep working
      const oldHost = device.getStore().host || device.getData().host;
      for (const d of this.getDevices()) {
        const dh = d.getStore().host || d.getData().host;
        if (dh === oldHost) {
          await d.setStoreValue('host', host).catch(() => {});
          await d.setStoreValue('username', username).catch(() => {});
          await d.setStoreValue('password', password).catch(() => {});
        }
      }
      // apply to the running poller too, so it re-logs-in with the new
      // credentials immediately instead of hammering the panel with the old ones
      this.homey.app.updatePollerCredentials(oldHost, { host, username, password });
      return true;
    });
  }

  async _discover(creds) {
    const api = new HikAxPro(creds);
    await api.login();
    let z; let ex; let s;
    try {
      [z, ex, s] = await Promise.all([
        api.zoneStatus(),
        api.exDevStatus().catch(() => null),
        api.subSystems().catch(() => null),
      ]);
    } finally {
      // always release the panel session, even when discovery throws
      await api.logout().catch(() => {});
    }

    const store = { host: creds.host, username: creds.username, password: creds.password };
    const devices = [{
      name: this.homey.__('device.panel'),
      data: { id: `panel-${creds.host}`, host: creds.host, type: 'panel' },
      store,
      icon: ICON('panel'),
      class: 'homealarm',
      capabilities: ['homealarm_state', 'alarm_tamper', 'alarm_mains'],
    }];

    // Areas / partitions (feature B) — one device per enabled area.
    for (const it of ((s && s.SubSysList) || [])) {
      const A = it.SubSys;
      if (!A || A.enabled === false) continue;
      devices.push({
        name: A.name || `${this.homey.__('device.area')} ${A.id}`,
        data: { id: `area-${creds.host}-${A.id}`, host: creds.host, type: 'area', areaId: A.id },
        store,
        icon: ICON('panel'),
        class: 'homealarm',
        capabilities: ['homealarm_state'],
      });
    }

    // Zones (detectors)
    for (const it of (z.ZoneList || [])) {
      const Z = it.Zone;
      const p = zoneProfile(Z.detectorType);
      const dev = {
        name: Z.name || `${this.homey.__('device.zone')} ${Z.id}`,
        data: { id: `zone-${creds.host}-${Z.id}`, host: creds.host, type: 'zone', zoneId: Z.id },
        store: { ...store, detectorType: Z.detectorType, cam: !!p.cam },
        icon: ICON(p.icon),
        class: p.cls,
        capabilities: p.caps,
      };
      // battery-powered detectors show up in Homey's battery overview
      if (p.caps.includes('measure_battery')) dev.energy = { batteries: ['OTHER'] };
      devices.push(dev);
    }

    // Peripherals (keypads, sirens, repeaters, outputs, card readers)
    const exDev = (ex && ex.ExDevStatus) || {};
    for (const p of PERIPHERALS) {
      for (const it of (exDev[p.list] || [])) {
        const D = it[p.item] || Object.values(it)[0];
        if (!D) continue;
        const caps = p.caps.filter((c) => c !== 'measure_temperature' || D.temperature !== undefined);
        // OutputList and OutputModList both map to type "output" (same control),
        // so the id must be distinct per list and the device must remember which
        // list it came from (device.js reads data.list for status lookups).
        const idPrefix = p.list === 'OutputModList' ? 'outputmod' : p.type;
        const dev = {
          name: D.name || `${p.type} ${D.id}`,
          data: {
            id: `${idPrefix}-${creds.host}-${D.id}`,
            host: creds.host,
            type: p.type,
            devId: D.id,
            list: p.list,
          },
          store,
          icon: ICON(p.icon),
          class: p.cls,
          capabilities: caps,
        };
        // battery-backed peripherals show up in Homey's battery overview
        if (caps.includes('measure_battery')) dev.energy = { batteries: ['OTHER'] };
        devices.push(dev);
      }
    }

    return devices;
  }
}

module.exports = PanelDriver;
