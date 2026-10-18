'use strict';
// Stateful mock-panel tests for the shared command path (ApiPoller.setArea /
// armAll / siren) used by BOTH the flow cards and the devices.
// Field reports covered: flow "Arm area (Away)" -> 400 armedStatus (2026-10-18),
// siren test/stop -> 404 notSupport on V1.3.1 build 251113 (2026-10-07).
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const ApiPoller = require('../lib/ApiPoller');

const CAPS = '<SessionLoginCap><sessionID>abc123</sessionID><challenge>ff00</challenge><iterations>100</iterations>'
  + '<isIrreversible>true</isIrreversible><salt>s1</salt><salt2>s2</salt2><sessionIDVersion>2.1</sessionIDVersion></SessionLoginCap>';
const ARMED_STATUS = '{"statusCode":4,"statusString":"Invalid Operation","subStatusCode":"armedStatus","errorCode":1073774619,"errorMsg":"armedStatus"}';
const NOT_SUPPORT = '<?xml version="1.0" encoding="UTF-8"?><ResponseStatus><requestURL>/ISAPI/SecurityCP/control/siren/test</requestURL>'
  + '<statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>';

/**
 * Fake AX PRO with real state. areas: { id: { name, arming } }. opts:
 *  - directSwitch: panel accepts stay->away without a disarm (default false:
 *    an armed area answers a new arm with 400 armedStatus)
 *  - siren: 'notSupport' | 'ok'
 *  - armBehind: { id, arming } applied right before the next arm PUT is
 *    answered (someone armed at the keypad between our read and our PUT)
 */
function panel(areas, opts, log) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const p = url.pathname;
      if (p.endsWith('/sessionLogin/capabilities')) { res.writeHead(200); return res.end(CAPS); }
      if (p === '/ISAPI/Security/sessionLogin') {
        res.writeHead(200, { 'Set-Cookie': 'WebSession_x=1; path=/' });
        return res.end('<SessionLoginResponse><sessionID>abc</sessionID></SessionLoginResponse>');
      }
      if (p === '/ISAPI/Security/sessionLogout') { res.writeHead(200); return res.end(); }
      if (p === '/ISAPI/SecurityCP/status/subSystems') {
        log.push('GET subSystems');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ SubSysList: Object.entries(areas).map(([id, a]) => (
          { SubSys: { id: Number(id), name: a.name, enabled: a.enabled !== false, arming: a.arming, alarm: false } })) }));
      }
      if (p.startsWith('/ISAPI/SecurityCP/control/')) {
        log.push(`${req.method} ${req.url}`);
        const parts = p.split('/');
        const verb = parts[4]; const id = parts[5];
        if (verb === 'siren') {
          if (opts.siren === 'ok') { res.writeHead(200); return res.end('{"statusCode":1}'); }
          res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end(NOT_SUPPORT);
        }
        if (opts.armBehind && verb === 'arm') { areas[opts.armBehind.id].arming = opts.armBehind.arming; opts.armBehind = null; }
        const ids = id === '0xffffffff' ? Object.keys(areas) : [id];
        if (verb === 'arm') {
          const ways = url.searchParams.get('ways');
          for (const i of ids) {
            const cur = areas[i].arming;
            if (cur !== 'disarm' && !(opts.directSwitch && cur !== ways)) {
              res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(ARMED_STATUS);
            }
          }
          for (const i of ids) areas[i].arming = ways;
        } else if (verb === 'disarm') {
          for (const i of ids) areas[i].arming = 'disarm';
        }
        res.writeHead(200); return res.end('{"statusCode":1}');
      }
      res.writeHead(404); res.end('nope');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function withPanel(areas, opts, fn) {
  const log = []; const appLog = [];
  const srv = await panel(areas, opts, log);
  const p = new ApiPoller({ host: '127.0.0.1', username: 'u', password: 'secretpw', appVersion: '9.9.9', log: (...a) => appLog.push(a.join(' ')) });
  p.api.port = srv.address().port;
  p._openStream = () => {};        // no alertStream in tests
  p.refreshSoon = () => {};        // no background polls
  try { await fn(p, log, appLog); } finally { srv.close(); }
}
const puts = (log) => log.filter((l) => l.startsWith('PUT'));

test('flow: disarmed -> away sends ONE arm to the real area id', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'disarm' } }, {}, async (p, log) => {
    assert.strictEqual(await p.setArea(1, 'away', 'flow'), 'sent');
    assert.deepStrictEqual(puts(log), ['PUT /ISAPI/SecurityCP/control/arm/1?ways=away&format=json']);
  }));

test('flow: already away -> away sends nothing (was: 400 armedStatus)', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'away' } }, {}, async (p, log) => {
    assert.strictEqual(await p.setArea(1, 'away', 'flow'), 'already');
    assert.deepStrictEqual(puts(log), []);
  }));

test('stale poll (says disarmed) is not trusted: fresh read decides', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'away' } }, {}, async (p, log) => {
    p.latest.subSystems = { 1: { id: 1, name: 'Gehele huis', arming: 'disarm' } };
    assert.strictEqual(await p.setArea(1, 'away', 'flow'), 'already');
    assert.deepStrictEqual(puts(log), []);
  }));

test('race: armed at the keypad between read and PUT -> 400 armedStatus verified as success', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'disarm' } }, { armBehind: { id: 1, arming: 'away' } }, async (p, log) => {
    assert.strictEqual(await p.setArea(1, 'away', 'flow'), 'already');
    assert.strictEqual(puts(log).length, 1);
  }));

test('stay -> away refused by panel: clear AREA_STATE error, never reported as success, no auto-disarm', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'stay' } }, {}, async (p, log) => {
    await assert.rejects(() => p.setArea(1, 'away', 'flow'),
      (e) => e.code === 'AREA_STATE' && e.current === 'stay' && e.want === 'away' && e.area === 'Gehele huis' && e.panelCode === 400);
    assert.ok(!puts(log).some((l) => l.includes('/disarm/')), 'must not disarm on its own');
  }));

test('stay -> away where the panel allows a direct switch: sent', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'stay' } }, { directSwitch: true }, async (p) => {
    assert.strictEqual(await p.setArea(1, 'away', 'flow'), 'sent');
  }));

test('flow disarm: armed -> disarm sent; already disarmed -> nothing sent', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'away' } }, {}, async (p, log) => {
    assert.strictEqual(await p.setArea(1, 'disarm', 'flow'), 'sent');
    assert.strictEqual(await p.setArea(1, 'disarm', 'flow'), 'already');
    assert.deepStrictEqual(puts(log), ['PUT /ISAPI/SecurityCP/control/disarm/1?format=json']);
  }));

test('device and flow take the identical path', () => withPanel(
  { 1: { name: 'A', arming: 'disarm' } }, {}, async (p, log) => {
    await p.setArea('1', ApiPoller.modeFor('armed'), 'device');
    const a = puts(log).slice();
    await p.setArea('1', 'disarm', 'device');
    log.length = 0;
    await p.setArea(1, 'away', 'flow');
    assert.deepStrictEqual(puts(log), a);
  }));

test('area mapping uses the panel id, not a list index', () => withPanel(
  { 1: { name: 'Huis', arming: 'disarm' }, 3: { name: 'Garage', arming: 'disarm' } }, {}, async (p, log) => {
    await p.setArea(3, 'stay', 'flow');
    assert.deepStrictEqual(puts(log), ['PUT /ISAPI/SecurityCP/control/arm/3?ways=stay&format=json']);
    assert.ok(p.latest.subSystems[3] && p.latest.subSystems[3].name === 'Garage');
  }));

test('panel device: whole system already away -> nothing sent', () => withPanel(
  { 1: { name: 'A', arming: 'away' }, 2: { name: 'B', arming: 'away' } }, {}, async (p, log) => {
    assert.strictEqual(await p.armAll('armed', 'device'), 'already');
    assert.deepStrictEqual(puts(log), []);
  }));

test('panel device: disarmed system -> wildcard arm', () => withPanel(
  { 1: { name: 'A', arming: 'disarm' }, 2: { name: 'B', arming: 'disarm' } }, {}, async (p, log) => {
    assert.strictEqual(await p.armAll('armed', 'device'), 'sent');
    assert.deepStrictEqual(puts(log), ['PUT /ISAPI/SecurityCP/control/arm/0xffffffff?ways=away&format=json']);
  }));

test('siren on and off on a notSupport panel: SIREN_NOT_SUPPORTED, separately', () => withPanel(
  { 1: { name: 'A', arming: 'disarm' } }, { siren: 'notSupport' }, async (p, log) => {
    await assert.rejects(() => p.siren(true), (e) => e.code === 'SIREN_NOT_SUPPORTED' && e.panelCode === 404);
    await assert.rejects(() => p.siren(false), (e) => e.code === 'SIREN_NOT_SUPPORTED' && e.panelCode === 404);
    assert.ok(puts(log).some((l) => l.includes('/siren/test')));
    assert.ok(puts(log).some((l) => l.includes('/siren/stop')));
  }));

test('siren on a panel that supports it: sent', () => withPanel(
  { 1: { name: 'A', arming: 'disarm' } }, { siren: 'ok' }, async (p) => {
    assert.strictEqual(await p.siren(true), 'sent');
    assert.strictEqual(await p.siren(false), 'sent');
  }));

test('command log: version, source, endpoint and panel answer — never the password or cookie', () => withPanel(
  { 1: { name: 'Gehele huis', arming: 'stay' } }, {}, async (p, log, appLog) => {
    await assert.rejects(() => p.setArea(1, 'away', 'flow'));
    const all = appLog.join('\n');
    assert.match(all, /app=9\.9\.9 source=flow area=1 want=away current=stay FAILED PUT \/ISAPI\/SecurityCP\/control\/arm\/1\?ways=away&format=json -> 400 armedStatus/);
    assert.match(all, /panel=\{"statusCode":4/);
    assert.ok(!all.includes('secretpw'));
    assert.ok(!all.includes('WebSession'));
  }));
