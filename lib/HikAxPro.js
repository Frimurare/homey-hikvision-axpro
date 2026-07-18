'use strict';
const http = require('http');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Minimal Hikvision AX PRO ISAPI client.
 * Handles the salt2 session-login (sessionIDVersion 2.1) that plain digest/2.0 miss.
 */
class HikAxPro {
  constructor({ host, username, password, port = 80, timeout = 12000 }) {
    this.host = host; this.port = port;
    this.username = username; this.password = password;
    this.timeout = timeout;
    this.cookie = null;
  }

  _request(method, path, { body = null, json = false } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.cookie) headers['Cookie'] = this.cookie;
      if (body) { headers['Content-Type'] = json ? 'application/json' : 'application/xml';
                  headers['Content-Length'] = Buffer.byteLength(body); }
      const req = http.request({ host: this.host, port: this.port, method, path, headers, timeout: this.timeout },
        (res) => {
          let data = '';
          const sc = res.headers['set-cookie'];
          if (sc) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  _xml(tag, s) { const m = s.match(new RegExp(`<${tag}>(.*?)</${tag}>`)); return m ? m[1] : null; }

  async login() {
    const cap = await this._request('GET',
      `/ISAPI/Security/sessionLogin/capabilities?username=${encodeURIComponent(this.username)}`);
    const x = (t) => this._xml(t, cap.body);
    const sid = x('sessionID'), ch = x('challenge'), salt = x('salt'), salt2 = x('salt2');
    const ver = x('sessionIDVersion'); const it = parseInt(x('iterations') || '100', 10);
    const irr = x('isIrreversible') === 'true';
    let r;
    if (ver === '2' && irr) {
      r = sha256(this.username + salt + this.password); r = sha256(r + ch);
      for (let i = 2; i < it; i++) r = sha256(r);
    } else if (irr) { // sessionIDVersion 2.1 -> salt2 step (critical)
      r = sha256(this.username + salt + this.password);
      r = sha256(this.username + salt2 + r);
      r = sha256(r + ch);
      for (let i = 2; i < it; i++) r = sha256(r);
    } else {
      r = sha256(this.password) + ch;
      for (let i = 1; i < it; i++) r = sha256(r);
    }
    const body = `<SessionLogin><userName>${this.username}</userName><password>${r}</password>`
      + `<sessionID>${sid}</sessionID><sessionIDVersion>${ver}</sessionIDVersion></SessionLogin>`;
    const res = await this._request('POST', '/ISAPI/Security/sessionLogin?timeStamp=1', { body });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body.slice(0, 120)}`);
    return true;
  }

  async logout() { try { await this._request('PUT', '/ISAPI/Security/sessionLogout'); } catch (e) {} this.cookie = null; }

  async _json(path) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await this._request('GET', `${path}${sep}format=json`);
    if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status}`);
    return JSON.parse(res.body);
  }

  zoneStatus()    { return this._json('/ISAPI/SecurityCP/status/zones'); }
  subSystems()    { return this._json('/ISAPI/SecurityCP/status/subSystems'); }
  hostStatus()    { return this._json('/ISAPI/SecurityCP/status/host'); }
  deviceInfo()    { return this._request('GET', '/ISAPI/System/deviceInfo'); }
  _control(path) { return this._request('PUT', path); }
  armAway(sub = '0xffffffff') { return this._control(`/ISAPI/SecurityCP/control/arm/${sub}?ways=away`); }
  armStay(sub = '0xffffffff') { return this._control(`/ISAPI/SecurityCP/control/arm/${sub}?ways=stay`); }
  disarm(sub = '0xffffffff')  { return this._control(`/ISAPI/SecurityCP/control/disarm/${sub}`); }
}

module.exports = HikAxPro;
