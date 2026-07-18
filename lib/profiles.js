'use strict';

/**
 * Map an AX PRO zone detectorType (as reported by the panel) to a Homey device
 * profile. Pattern-based so it covers the whole AX PRO catalogue (and future
 * models) — motion, contact, smoke, glass, water, CO, gas, heat/temp, panic.
 * Order matters: check the more specific substrings before the generic ones.
 */
function zoneProfile(detectorType) {
  const t = String(detectorType || '').toLowerCase();
  const base = ['measure_temperature', 'measure_battery', 'alarm_tamper'];
  // contact / magnet / shock (check before "co")
  if (t.includes('magnet') || t.includes('contact') || t.includes('shock'))
    return { icon: 'contact', cls: 'sensor', caps: ['alarm_contact', ...base] };
  if (t.includes('smoke'))
    return { icon: 'smoke', cls: 'sensor', caps: ['alarm_smoke', ...base] };
  if (t.includes('glass'))
    return { icon: 'glass', cls: 'sensor', caps: ['alarm_generic', ...base] };
  if (t.includes('water') || t.includes('leak') || t.includes('flood'))
    return { icon: 'water', cls: 'sensor', caps: ['alarm_water', ...base] };
  if (t.includes('codetector') || t.includes('carbonmon') || t === 'co')
    return { icon: 'gas', cls: 'sensor', caps: ['alarm_co', ...base] };
  if (t.includes('gas'))
    return { icon: 'gas', cls: 'sensor', caps: ['alarm_co2', ...base] };
  if (t.includes('temp') || t.includes('heat') || t.includes('pdht') || t.includes('pdtph'))
    return { icon: 'heat', cls: 'sensor', caps: ['measure_temperature', 'measure_battery', 'alarm_tamper', 'alarm_heat'] };
  if (t.includes('panic') || t.includes('emergency') || t.includes('button') || t.includes('pdeb'))
    return { icon: 'panic', cls: 'button', caps: ['alarm_generic', 'measure_battery', 'alarm_tamper'] };
  if (t.includes('pir') || t.includes('motion') || t.includes('curtain') || t.includes('cam')
      || t.includes('dual') || t.includes('panoramic') || t.includes('triple') || t.includes('infrared'))
    return { icon: 'motion', cls: 'sensor', caps: ['alarm_motion', ...base] };
  return { icon: 'generic', cls: 'sensor', caps: base };
}

// Peripheral categories from exDevStatus -> device profile
const PERIPHERALS = [
  { list: 'KeypadList',    item: 'Keypad',    type: 'keypad',    icon: 'keypad',   cls: 'sensor', caps: ['measure_temperature', 'measure_battery', 'alarm_tamper'] },
  { list: 'SirenList',     item: 'Siren',     type: 'siren',     icon: 'siren',    cls: 'sensor', caps: ['measure_battery', 'alarm_tamper'] },
  { list: 'RepeaterList',  item: 'Repeater',  type: 'repeater',  icon: 'repeater', cls: 'sensor', caps: ['measure_battery', 'alarm_tamper'] },
  { list: 'CardReaderList', item: 'CardReader', type: 'cardreader', icon: 'generic', cls: 'sensor', caps: ['measure_battery', 'alarm_tamper'] },
  { list: 'OutputList',    item: 'Output',    type: 'output',    icon: 'output',   cls: 'socket', caps: ['onoff'] },
  { list: 'OutputModList', item: 'OutputMod', type: 'output',    icon: 'output',   cls: 'socket', caps: ['onoff'] },
];

module.exports = { zoneProfile, PERIPHERALS };
