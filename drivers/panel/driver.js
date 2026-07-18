'use strict';
const Homey = require('homey');
const HikAxPro = require('../../lib/HikAxPro');

const CAPS = {
  pircam:                ['alarm_motion', 'measure_temperature', 'measure_battery', 'alarm_tamper'],
  passiveInfrared:       ['alarm_motion', 'measure_temperature', 'measure_battery', 'alarm_tamper'],
  magneticContact:       ['alarm_contact', 'measure_temperature', 'measure_battery', 'alarm_tamper'],
  wirelessSmokeDetector: ['alarm_smoke', 'measure_temperature', 'measure_battery', 'alarm_tamper'],
};
const CLASS = {
  magneticContact: 'sensor', pircam: 'sensor', passiveInfrared: 'sensor', wirelessSmokeDetector: 'sensor',
};

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
      const z = await api.zoneStatus();
      await api.logout();

      const devices = [{
        name: 'AX PRO Panel',
        data: { id: `panel-${creds.host}`, host: creds.host, type: 'panel' },
        store: { username: creds.username, password: creds.password },
        class: 'homealarm',
        capabilities: ['homealarm_state'],
      }];

      for (const it of (z.ZoneList || [])) {
        const Z = it.Zone;
        const caps = CAPS[Z.detectorType] || ['measure_temperature', 'measure_battery', 'alarm_tamper'];
        devices.push({
          name: Z.name || `Zone ${Z.id}`,
          data: { id: `zone-${creds.host}-${Z.id}`, host: creds.host, type: 'zone', zoneId: Z.id },
          store: { username: creds.username, password: creds.password, detectorType: Z.detectorType },
          class: CLASS[Z.detectorType] || 'sensor',
          capabilities: caps,
        });
      }
      return devices;
    });
  }
}

module.exports = PanelDriver;
