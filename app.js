'use strict';
const Homey = require('homey');
const ApiPoller = require('./lib/ApiPoller');

class HikAxProApp extends Homey.App {
  async onInit() {
    this._pollers = new Map(); // host -> ApiPoller
    this.log('Hikvision AX PRO app started');
  }

  getPoller({ host, username, password }) {
    if (!this._pollers.has(host)) {
      const p = new ApiPoller({ host, username, password });
      this._pollers.set(host, p);
      p.start();
    }
    return this._pollers.get(host);
  }

  releasePoller(host) {
    const p = this._pollers.get(host);
    if (p && !p.hasSubscribers()) { p.stop(); this._pollers.delete(host); }
  }
}

module.exports = HikAxProApp;
