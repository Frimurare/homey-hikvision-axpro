'use strict';
const Homey = require('homey');
const HikAxPro = require('../../lib/HikAxPro');
const { zoneProfile, PERIPHERALS } = require('../../lib/profiles');

// Homey resolves the pairing `icon` path relative to /drivers/<id>/assets/,
// so it must be just "/name.svg" (NOT the full /drivers/... path).
const ICON = (name) => `/${name}.svg`;

class PanelDriver extends Homey.Driver {
  async onPair(session) {
    let creds = null;

    session.setHandler('connect', async ({ host, username, password }) => {
      const api = new HikAxPro({ host, username, password });
      await api.login();           // throws on bad credentials -> shown in pair view
      await api.logout();
      creds = { host, username, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!creds) throw new Error('Not connected');
      const api = new HikAxPro(creds);
      await api.login();
      const [z, ex] = await Promise.all([
        api.zoneStatus(),
        api.exDevStatus().catch(() => null),
      ]);
      await api.logout();

      const store = { username: creds.username, password: creds.password };
      const devices = [{
        name: this.homey.__('device.panel'),
        data: { id: `panel-${creds.host}`, host: creds.host, type: 'panel' },
        store,
        icon: ICON('panel'),
        class: 'homealarm',
        capabilities: ['homealarm_state'],
      }];

      // Zones (detectors)
      for (const it of (z.ZoneList || [])) {
        const Z = it.Zone;
        const p = zoneProfile(Z.detectorType);
        devices.push({
          name: Z.name || `${this.homey.__('device.zone')} ${Z.id}`,
          data: { id: `zone-${creds.host}-${Z.id}`, host: creds.host, type: 'zone', zoneId: Z.id },
          store: { ...store, detectorType: Z.detectorType },
          icon: ICON(p.icon),
          class: p.cls,
          capabilities: p.caps,
        });
      }

      // Peripherals (keypads, sirens, repeaters, outputs, card readers)
      const exDev = (ex && ex.ExDevStatus) || {};
      for (const p of PERIPHERALS) {
        for (const it of (exDev[p.list] || [])) {
          const D = it[p.item] || Object.values(it)[0];
          if (!D) continue;
          // only expose temp for peripherals that actually report it
          const caps = p.caps.filter((c) => c !== 'measure_temperature' || D.temperature !== undefined);
          devices.push({
            name: D.name || `${p.type} ${D.id}`,
            data: { id: `${p.type}-${creds.host}-${D.id}`, host: creds.host, type: p.type, devId: D.id },
            store,
            icon: ICON(p.icon),
            class: p.cls,
            capabilities: caps,
          });
        }
      }

      return devices;
    });
  }
}

module.exports = PanelDriver;
