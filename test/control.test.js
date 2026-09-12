'use strict';
// Mock-panel tests for the SecurityCP control layer and login negotiation.
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const HikAxPro = require('../lib/HikAxPro');

const XML404 = '<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="1.0" xmlns="urn:psialliance-org">'
  + '<requestURL>/ISAPI/SecurityCP/control/arm/0xffffffff</requestURL><statusCode>4</statusCode>'
  + '<statusString>Invalid Operation</statusString><subStatusCode>methodNotAllowed</subStatusCode></ResponseStatus>';
const CAPS = (extra = '') => '<SessionLoginCap version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">'
  + '<sessionID>abc123</sessionID><challenge>ff00</challenge><iterations>100</iterations>'
  + '<isIrreversible>true</isIrreversible><salt>s1</salt><salt2>s2</salt2>' + extra + '</SessionLoginCap>';

/** Start a fake panel. `mode` decides how arm/disarm behave. */
function panel(mode, log) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (url.pathname.endsWith('/sessionLogin/capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(CAPS(mode === 'caps-no-version' ? '' : '<sessionIDVersion>2.1</sessionIDVersion>'));
      }
      if (url.pathname === '/ISAPI/Security/sessionLogin') {
        log.push(`LOGINBODY ${body}`);
        if (mode === 'login-denied') {
          res.writeHead(401, { 'Content-Type': 'application/xml' });
          return res.end('<ResponseStatus><statusCode>4</statusCode><subStatusCode>badAuthorization</subStatusCode><unlockTime>480</unlockTime></ResponseStatus>');
        }
        res.writeHead(200, { 'Set-Cookie': 'WebSession_x=1; path=/' });
        return res.end('<SessionLoginResponse><sessionID>abc</sessionID></SessionLoginResponse>');
      }
      if (url.pathname === '/ISAPI/Security/sessionLogout') { res.writeHead(200); return res.end(); }
      if (url.pathname.startsWith('/ISAPI/SecurityCP/control/')) {
        const json = url.searchParams.get('format') === 'json';
        const id = url.pathname.split('/').pop();
        const isArm = url.pathname.includes('/arm/');
        if (mode === 'legacy') { res.writeHead(200); return res.end(json ? '{"statusCode":1}' : '<ResponseStatus><statusCode>1</statusCode></ResponseStatus>'); }
        if (mode === 'json-only-arm') { // V1.3.1 build 251113 behaviour
          if (isArm && !json) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end(XML404); }
          res.writeHead(200); return res.end('{"statusCode":1}');
        }
        if (mode === 'no-wildcard') {
          if (id === '0xffffffff') { res.writeHead(404); return res.end(XML404); }
          res.writeHead(200); return res.end('{"statusCode":1}');
        }
        if (mode === 'refuse') { // open zone: real refusal, must not be retried
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end('{"statusCode":4,"statusString":"Invalid Operation","subStatusCode":"arming","errorCode":1073774621,"errorMsg":"arming"}');
        }
      }
      res.writeHead(404); res.end('nope');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function withPanel(mode, fn) {
  const log = [];
  const srv = await panel(mode, log);
  const api = new HikAxPro({ host: '127.0.0.1', port: srv.address().port, username: 'u', password: 'p' });
  try { await fn(api, log); } finally { srv.close(); }
}

test('legacy panel: arm works first try, JSON form remembered', () => withPanel('legacy', async (api, log) => {
  await api.armAway();
  assert.deepStrictEqual(log, ['PUT /ISAPI/SecurityCP/control/arm/0xffffffff?ways=away&format=json']);
  await api.disarm();
  assert.strictEqual(log.length, 2);
}));

test('json-only firmware: plain arm 404 never reached, disarm fine', () => withPanel('json-only-arm', async (api, log) => {
  await api.armAll('away', [1, 2]);
  assert.deepStrictEqual(log, ['PUT /ISAPI/SecurityCP/control/arm/0xffffffff?ways=away&format=json']);
  await api.armAll('disarm', [1, 2]);
  assert.strictEqual(log.length, 2);
}));

test('json 404 falls back to plain URL, then remembers plain', () => withPanel('legacy', async (api, log) => {
  api._ctlStyle = 'plain'; // simulate a panel where plain was what worked
  await api.armStay('1');
  assert.deepStrictEqual(log, ['PUT /ISAPI/SecurityCP/control/arm/1?ways=stay']);
}));

test('wildcard rejected: arms each enabled area instead', () => withPanel('no-wildcard', async (api, log) => {
  await api.armAll('away', [1, 3]);
  assert.deepStrictEqual(log, [
    'PUT /ISAPI/SecurityCP/control/arm/0xffffffff?ways=away&format=json',
    'PUT /ISAPI/SecurityCP/control/arm/0xffffffff?ways=away',
    'PUT /ISAPI/SecurityCP/control/arm/1?ways=away&format=json',
    'PUT /ISAPI/SecurityCP/control/arm/3?ways=away&format=json',
  ]);
}));

test('wildcard rejected and no areas known: error carries notFound', () => withPanel('no-wildcard', async (api) => {
  await assert.rejects(() => api.armAll('away', []), (e) => e.notFound === true && e.code === 404);
}));

test('panel refusal (open zone) is surfaced once, not retried', () => withPanel('refuse', async (api, log) => {
  await assert.rejects(() => api.armAll('away', [1]), (e) => /arming/.test(e.message) && e.code === 400 && !e.notFound);
  assert.strictEqual(log.length, 1);
}));

test('login: salt2 scheme, web-page element order, cookie kept', () => withPanel('legacy', async (api, log) => {
  await api.login();
  const body = log.find((l) => l.startsWith('LOGINBODY ')).slice(10);
  assert.match(body, /^<SessionLogin><userName>u<\/userName><password>[0-9a-f]{64}<\/password><sessionID>abc123<\/sessionID><isSessionIDValidLongTerm>false<\/isSessionIDValidLongTerm><sessionIDVersion>2\.1<\/sessionIDVersion><\/SessionLogin>$/);
  assert.strictEqual(api.cookie, 'WebSession_x=1');
  assert.ok(api.capFields.includes('salt2'));
}));

test('login: missing sessionIDVersion defaults to 2.1 when salt2 present (no "null" in body)', () => withPanel('caps-no-version', async (api, log) => {
  await api.login();
  const body = log.find((l) => l.startsWith('LOGINBODY ')).slice(10);
  assert.ok(!body.includes('null'));
  assert.match(body, /<sessionIDVersion>2\.1<\/sessionIDVersion>/);
}));

test('login denied: short reason + unlockTime', () => withPanel('login-denied', async (api) => {
  await assert.rejects(() => api.login(), (e) => e.code === 401 && e.reason === 'badAuthorization' && e.unlockTime === 480);
}));
