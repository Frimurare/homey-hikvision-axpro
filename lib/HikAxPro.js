'use strict';
const http = require('http');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const xmlEsc = (s) => String(s).replace(/[&<>'"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]));

// The panel's own endpoint list documents arming as
//   /ISAPI/SecurityCP/control/arm/<ID>?ways=<string>&format=json
// while disarm/bypass are listed without format. Older firmware answers the
// plain URL too; newer builds (seen on V1.3.1 build 251113) answer it with
// 404 "methodNotAllowed" — which is why "arm fails, disarm works" was reported.
const WILDCARD_SUB = '0xffffffff';

/** True when the panel says "no such handler" rather than "refused". */
const isNotFound = (res) => res.status === 404 || res.status === 405
  || /methodNotAllowed|notSupport/i.test(String(res.body || ''));

/** Short reason from a ResponseStatus body (XML or JSON), e.g. "arming", "badAuthorization". */
function reasonOf(body) {
  const s = String(body || '');
  const m = s.match(/"subStatusCode"\s*:\s*"([^"]+)"/) || s.match(/<subStatusCode>([^<]+)<\/subStatusCode>/);
  if (m) return m[1];
  const e = s.match(/"errorMsg"\s*:\s*"([^"]+)"/) || s.match(/<statusString>([^<]+)<\/statusString>/);
  return e ? e[1] : '';
}

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
    this._ctlStyle = null;   // 'json' | 'plain' — remembered once a control call succeeds
    this.capFields = [];     // field names seen in the last login-capabilities response (diagnostics)
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
          res.on('error', reject);
        });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  // Tolerates attributes on the element (<salt2 foo="x">…</salt2>) and whitespace.
  _xml(tag, s) {
    const m = String(s || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  }

  async login() {
    const cap = await this._request('GET',
      `/ISAPI/Security/sessionLogin/capabilities?username=${encodeURIComponent(this.username)}`);
    if (cap.status !== 200) {
      const err = new Error(`login failed: capabilities ${cap.status} ${reasonOf(cap.body)}`.trim());
      err.code = cap.status; err.reason = reasonOf(cap.body);
      throw err;
    }
    const x = (t) => this._xml(t, cap.body);
    // Diagnostics: which fields this build returns (values are NOT logged).
    this.capFields = ['sessionID', 'challenge', 'salt', 'salt2', 'iterations', 'sessionIDVersion',
      'isIrreversible', 'isSupportSessionIDValidLongTerm']
      .filter((f) => x(f) !== null);
    const sid = x('sessionID'), ch = x('challenge'), salt = x('salt'), salt2 = x('salt2');
    if (!sid || !ch) {
      const err = new Error('login failed: unexpected capabilities response (missing sessionID/challenge)');
      err.code = 'caps'; throw err;
    }
    // Newer builds may omit sessionIDVersion; salt2 present means the 2.1 scheme.
    const ver = x('sessionIDVersion') || (salt2 ? '2.1' : '2');
    const itRaw = parseInt(x('iterations') || '100', 10);
    const it = Number.isFinite(itRaw) && itRaw > 0 ? itRaw : 100;
    // Older firmware only advertised salted hashing via isIrreversible; if the
    // field is absent but a salt is, the panel is salted anyway.
    const irr = x('isIrreversible') === null ? !!salt : x('isIrreversible') === 'true';
    let r;
    if (irr && salt2 && ver !== '2') { // sessionIDVersion 2.1 -> salt2 step (critical)
      r = sha256(this.username + salt + this.password);
      r = sha256(this.username + salt2 + r);
      r = sha256(r + ch);
      for (let i = 2; i < it; i++) r = sha256(r);
    } else if (irr) {
      r = sha256(this.username + (salt || '') + this.password); r = sha256(r + ch);
      for (let i = 2; i < it; i++) r = sha256(r);
    } else {
      r = sha256(this.password) + ch;
      for (let i = 1; i < it; i++) r = sha256(r);
    }
    // Same element order as the panel's own web page sends.
    const body = `<SessionLogin><userName>${xmlEsc(this.username)}</userName><password>${r}</password>`
      + `<sessionID>${sid}</sessionID><isSessionIDValidLongTerm>false</isSessionIDValidLongTerm>`
      + `<sessionIDVersion>${xmlEsc(ver)}</sessionIDVersion></SessionLogin>`;
    const res = await this._request('POST', '/ISAPI/Security/sessionLogin?timeStamp=1', { body });
    // A denied login is a ResponseStatus (statusCode != 1); success is a SessionLoginResponse.
    const denied = res.status !== 200
      || (/<ResponseStatus/i.test(res.body) && !/<statusCode>1<\/statusCode>/.test(res.body));
    if (denied) {
      const reason = reasonOf(res.body);
      const unlock = this._xml('unlockTime', res.body);
      const err = new Error(`login failed: ${res.status} ${reason}`.trim());
      err.code = res.status; err.reason = reason;
      // for the app log / diagnostic report: the panel's answer (no secrets in
      // it) and which capability fields this build returned
      err.body = String(res.body || '').replace(/\s+/g, ' ').slice(0, 400);
      err.capFields = this.capFields.slice();
      if (unlock) err.unlockTime = parseInt(unlock, 10);
      throw err;
    }
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

  /** Model / firmware for diagnostics: { model, firmware, build } (best-effort, never throws). */
  async deviceSummary() {
    try {
      const res = await this.deviceInfo();
      if (res.status !== 200) return { model: '?', firmware: `deviceInfo ${res.status}`, build: '' };
      const x = (t) => this._xml(t, res.body) || '';
      return { model: x('model'), firmware: x('firmwareVersion'), build: x('firmwareVersionInfo') || x('firmwareReleasedDate') };
    } catch (e) { return { model: '?', firmware: '?', build: '' }; }
  }

  sirenTest(on)   { return this._control(`/ISAPI/SecurityCP/control/siren/${on ? 'test' : 'stop'}`); }
  async setOutput(id, on) {
    const body = JSON.stringify({ OutputsCtrl: { switch: on ? 'open' : 'close' } });
    const res = await this._request('PUT', `/ISAPI/SecurityCP/control/outputs/${id}?format=json`, { body, json: true });
    if (res.status !== 200) throw new Error(`setOutput ${id} -> ${res.status} ${String(res.body).slice(0, 120)}`);
    return res;
  }

  /**
   * PUT a SecurityCP control URL. Tries the JSON form (`&format=json`) first —
   * the only form documented for arm, and the one the panel's newer builds
   * still answer — then the plain URL. Whichever works is remembered, so
   * normal operation is one request. A refusal (400 "arming", 401, 403…) is
   * thrown as-is and never retried in the other style.
   */
  async _control(path) {
    const other = (s) => (s === 'json' ? 'plain' : 'json');
    const styles = this._ctlStyle ? [this._ctlStyle, other(this._ctlStyle)] : ['json', 'plain'];
    let last = null;
    for (const style of styles) {
      const url = style === 'json' ? `${path}${path.includes('?') ? '&' : '?'}format=json` : path;
      const res = await this._request('PUT', url);
      if (res.status === 200) { this._ctlStyle = style; return res; }
      last = { url, res };
      if (!isNotFound(res)) break; // a real answer from the panel — surface it
    }
    const reason = reasonOf(last.res.body);
    const err = new Error(`PUT ${last.url} -> ${last.res.status}${reason ? ` ${reason}` : ''}`);
    err.code = last.res.status; err.reason = reason; err.notFound = isNotFound(last.res);
    throw err;
  }

  armAway(sub = WILDCARD_SUB) { return this._control(`/ISAPI/SecurityCP/control/arm/${sub}?ways=away`); }
  armStay(sub = WILDCARD_SUB) { return this._control(`/ISAPI/SecurityCP/control/arm/${sub}?ways=stay`); }
  disarm(sub = WILDCARD_SUB)  { return this._control(`/ISAPI/SecurityCP/control/disarm/${sub}`); }

  /**
   * Arm/disarm the whole system. Uses the 0xffffffff wildcard when the panel
   * accepts it; if the panel answers "no such handler" for the wildcard, the
   * command is sent per area instead (`subIds` = the enabled areas).
   * mode: 'away' | 'stay' | 'disarm'
   */
  async armAll(mode, subIds = []) {
    const fn = mode === 'stay' ? 'armStay' : (mode === 'away' ? 'armAway' : 'disarm');
    try {
      return await this[fn](WILDCARD_SUB);
    } catch (e) {
      const ids = (subIds || []).map(String).filter((id) => id && id !== WILDCARD_SUB);
      if (!e.notFound || ids.length === 0) throw e;
      for (const id of ids) await this[fn](id);
      return true;
    }
  }

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
   * `onClose` (optional) fires once when the stream ends or errors, so the
   * caller knows to reopen it.
   */
  openAlertStream(onEvent, onClose) {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (onClose) { try { onClose(); } catch (e) {} }
    };
    const headers = {};
    if (this.cookie) headers['Cookie'] = this.cookie;
    const req = http.request({
      host: this.host, port: this.port, method: 'GET',
      path: '/ISAPI/Event/notification/alertStream', headers, timeout: 0,
    }, (res) => {
      if (res.statusCode !== 200) {
        // e.g. a 401 login page — must not be parsed as event parts
        res.resume();
        res.on('error', () => {});
        close();
        return;
      }
      // Split on the real multipart boundary from the Content-Type header;
      // fall back to the generic "\r\n--" only if the panel sent no boundary.
      const ct = res.headers['content-type'] || '';
      const bm = ct.match(/boundary="?([^";,\s]+)"?/i);
      const marker = Buffer.from(bm ? `\r\n--${bm[1]}` : '\r\n--', 'latin1');
      let buf = Buffer.alloc(0);
      res.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // We look for JSON objects and JPEG (FFD8..FFD9) inside each part.
        let idx;
        while ((idx = buf.indexOf(marker, 1)) !== -1) {
          const part = buf.slice(0, idx);
          buf = buf.slice(idx + 2); // keep the boundary for the next round
          this._emitPart(part, onEvent);
        }
        if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024); // safety cap
      });
      res.on('end', () => { this._emitPart(buf, onEvent); close(); });
      res.on('close', close);
      res.on('error', () => { close(); });
    });
    req.on('error', () => { close(); });
    req.on('close', close);
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
      // lastIndexOf: an embedded EXIF thumbnail can contain an earlier FFD9
      const e = part.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (e > s) image = part.slice(s, e + 2);
    }
    if (json || image) { try { onEvent({ json, image }); } catch (err) {} }
  }
}

HikAxPro.WILDCARD_SUB = WILDCARD_SUB;
module.exports = HikAxPro;
