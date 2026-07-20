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
  exDevStatus()   { return this._json('/ISAPI/SecurityCP/status/exDevStatus'); } // keypads/sirens/repeaters/outputs
  deviceInfo()    { return this._request('GET', '/ISAPI/System/deviceInfo'); }
  sirenTest(on)   { return this._control(`/ISAPI/SecurityCP/control/siren/${on ? 'test' : 'stop'}`); }
  setOutput(id, on) {
    const body = JSON.stringify({ OutputsCtrl: { switch: on ? 'open' : 'close' } });
    return this._request('PUT', `/ISAPI/SecurityCP/control/outputs/${id}?format=json`, { body, json: true });
  }
  _control(path) { return this._request('PUT', path); }
  armAway(sub = '0xffffffff') { return this._control(`/ISAPI/SecurityCP/control/arm/${sub}?ways=away`); }
  armStay(sub = '0xffffffff') { return this._control(`/ISAPI/SecurityCP/control/arm/${sub}?ways=stay`); }
  disarm(sub = '0xffffffff')  { return this._control(`/ISAPI/SecurityCP/control/disarm/${sub}`); }

  // Bypass (shunt) a zone so it is ignored while armed, or recover it.
  bypassZone(id, on) {
    return this._control(`/ISAPI/SecurityCP/control/${on ? 'bypass' : 'Recoverbypass'}/${id}`);
  }

  /**
   * Open the panel's real-time event stream (long-lived multipart HTTP).
   * Calls onEvent({ json, image }) for each event block — json is the parsed
   * event object (best-effort), image is a Buffer JPEG if the block carried one
   * (e.g. a PIR-CAM capture on alarm). Returns the request so the caller can
   * .destroy() it. Auto-parses the multipart boundary stream.
   */
  openAlertStream(onEvent) {
    const headers = {};
    if (this.cookie) headers['Cookie'] = this.cookie;
    const req = http.request({
      host: this.host, port: this.port, method: 'GET',
      path: '/ISAPI/Event/notification/alertStream', headers, timeout: 0,
    }, (res) => {
      let buf = Buffer.alloc(0);
      res.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // Split on the multipart boundary marker "--boundary" (panels use --MIME_boundary or similar).
        // We look for JSON objects and JPEG (FFD8..FFD9) inside the accumulated buffer.
        let idx;
        while ((idx = buf.indexOf('\r\n--', 1)) !== -1) {
          const part = buf.slice(0, idx);
          buf = buf.slice(idx + 2); // keep the boundary for the next round
          this._emitPart(part, onEvent);
          if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024); // safety cap
        }
      });
      res.on('end', () => { this._emitPart(buf, onEvent); });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    return req;
  }

  _emitPart(part, onEvent) {
    if (!part || part.length < 4) return;
    const text = part.toString('latin1');
    let json = null;
    const jStart = text.indexOf('{');
    const jEnd = text.lastIndexOf('}');
    if (jStart !== -1 && jEnd > jStart) {
      try { json = JSON.parse(part.slice(jStart, jEnd + 1).toString('utf8')); } catch (e) { json = null; }
    }
    // JPEG payload between FFD8 and FFD9
    let image = null;
    const s = part.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (s !== -1) {
      const e = part.indexOf(Buffer.from([0xff, 0xd9]), s);
      if (e !== -1) image = part.slice(s, e + 2);
    }
    if (json || image) { try { onEvent({ json, image }); } catch (err) {} }
  }
}

module.exports = HikAxPro;
