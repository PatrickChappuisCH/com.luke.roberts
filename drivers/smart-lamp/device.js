'use strict';

const Homey = require('homey');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const COMMAND_QUEUE_RETRY = 4;
const BLE_DISCONNECT_TIMEOUT = 0;
const BLE_SEARCH_TIMEOUT = 30;

const { SERVICE_UUID, API_CHARACTERISTIC_UUID } = require('../../config');

class SmartLampDevice extends Homey.Device {
  static get LAMP_WATT_MIN() { return 0.5; }
  static get LAMP_WATT_MAX() { return 75; }

  async onInit() {
    this.log('SmartLampDevice has been inited');
    this.setUnavailable();

    this.registerMultipleCapabilityListener(
      ['onoff','dim','light_hue','light_saturation','light_mode','light_temperature'],
      this._onCapabilityLight.bind(this),
      300
    );

    this._device = null;
    this._peripheral = null;

    this._connectionTimer = null;
    this._commandBusy = false;
    this._commandQueue = [];
    this._commandRetry = 0;

    // scenes cache + throttling
    this._scenes = [];
    this._sceneScanInProgress = false;
    this._scenesFetchedAt = 0;
    this._scenesTtlMs = 10 * 60 * 1000;

    // scene enumeration state
    this._sceneVisited = new Set();     // anti-boucle sur index
    this._sceneNames = new Set();       // anti-doublon par nom
    this._sceneLastRequested = null;    // dernier index demandé

    // scan timer
    this._searchTimer = null;

    // exponential backoff
    this._scanDelayMs = 5_000;
    this._scanDelayMax = 300_000;

    // coalescing
    this._lastCmdKey = null;
    this._lastCmdTs = 0;

    // notifications session flag (scènes)
    this._notifActive = false;

    // initial scan
    this._searchDevice(0);
  }

  async _onDeviceInit() {
    this.setAvailable();
    this._calculatePower();

    const now = Date.now();
    if (!this._sceneScanInProgress && (now - this._scenesFetchedAt) > this._scenesTtlMs) {
      this._getScenes();
    }

    // reset backoff on success
    this._scanDelayMs = 5_000;
  }

  async _searchDevice(timeout) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(async () => {
      this._searchTimer = null;
      const { id } = this.getData();
      let adv = null;
      try { adv = await this.homey.ble.find(id); }
      catch (e) { this.log('BLE find failed:', e.statusCode || e.message || e); }

      if (adv && adv.id === id) {
        this._device = adv;
        try { await this._onDeviceInit(); } catch (err) { this.error(err); }
      } else {
        const nextSec = Math.min(this._scanDelayMs, this._scanDelayMax) / 1000;
        this._scanDelayMs = Math.min(this._scanDelayMs * 2, this._scanDelayMax);
        this._searchDevice(nextSec);
      }
    }, (timeout || 0) * 1000);
  }

  _connectionTimerStart(timeout) {
    this._connectionTimerStop();
    if (timeout > 0) {
      this._connectionTimer = setTimeout(() => {
        this._connectionTimer = null;
        this._disconnect();
      }, timeout * 1000);
    }
  }
  _connectionTimerStop() {
    if (this._connectionTimer) { clearTimeout(this._connectionTimer); this._connectionTimer = null; }
  }

  async _getService() {
    if (this._peripheral && this._peripheral.isConnected) {
      this._connectionTimerStop();
      const BLEservice = await this._peripheral.getService(SERVICE_UUID);
      return Promise.resolve(BLEservice);
    }
    if (this._connectionTimer) {
      this._connectionTimerStop();
      return Promise.resolve(null);
    }

    this.log('_getService connecting');
    this._connectionTimerStop();

    try {
      const fresh = await this.homey.ble.find(this.getData().id);
      if (fresh) this._device = fresh; else return null;
    } catch (_) { return null; }

    try {
      this._peripheral = await this._device.connect();

      this._peripheral.once('disconnect', async () => {
        this._peripheral = null;
        this._device = null;
        this._notifActive = false;     // drop notify session flag on disconnect
        this._disconnect();
      });

      await this._peripheral.discoverAllServicesAndCharacteristics();
      const BLEservice = await this._peripheral.getService(SERVICE_UUID);
      if (!BLEservice) return Promise.reject(new Error('missing_service'));

      await sleep(200); // settle
      return Promise.resolve(BLEservice);

    } catch (e) {
      this.log('_getService connect fail:', e.message);
      this._peripheral = null; this._device = null;
      const nextSec = Math.min(this._scanDelayMs, this._scanDelayMax) / 1000;
      this._scanDelayMs = Math.min(this._scanDelayMs * 2, this._scanDelayMax);
      this._searchDevice(nextSec);
      return null;
    }
  }

  async _disconnect() {
    this.log('_disconnect');

    this._commandBusy = true;
    this._connectionTimerStop();

    if (this._peripheral && this._peripheral.isConnected) {
      await this._peripheral.disconnect().catch(() => null);
    }
    this._commandBusy = false;
    delete this._peripheral;

    setTimeout(() => { this._processQueue(true).catch(() => null); }, 500);

    const nextSec = Math.min(this._scanDelayMs, this._scanDelayMax) / 1000;
    this._scanDelayMs = Math.min(this._scanDelayMs * 2, this._scanDelayMax);
    this._searchDevice(nextSec);

    return Promise.resolve(true);
  }

  async _processQueue(retry) {
    this.log('_processQueue', this._commandRetry, this._commandQueue.length);

    if (retry) this._commandRetry++;
    if (this._commandRetry >= COMMAND_QUEUE_RETRY) {
      this.log('_processQueue retries exceeded');
      this._commandQueue = [];
      this._commandRetry = 0;
    }
    if (this._commandQueue.length === 0) { this.log('_processQueue empty'); return Promise.resolve(true); }

    try {
      if (this._commandBusy) { this.log('_processQueue is busy'); return Promise.resolve(true); }
      this._commandBusy = true;

      const service = await this._getService().catch((error) => this.log(error));
      if (!service) {
        this.log('_processQueue service missing');
        setTimeout(() => { this._processQueue(true).catch(() => null); }, 500);
        this._commandBusy = false;
        return Promise.resolve(true);
      }

      while (this._commandQueue.length > 0) {
        this._connectionTimerStop();
        const command = this._commandQueue.shift();

        await sleep(100); // guard after reconnect
        this.log('_processQueue writing', command);

        const characteristic = await service.getCharacteristic(API_CHARACTERISTIC_UUID);

        // subscribe once for scenes enumeration
        if (command[2] === 0x01 && !this._notifActive) {
          try {
            this._notifActive = true;
            this._sceneVisited.clear();
            this._sceneNames.clear();
            this._sceneLastRequested = 0; // we start by requesting index 0

            await characteristic.subscribeToNotifications(async (data) => {
              // multiple scene notifications expected; no "handled" short-circuit
              this.log('_processQueue notification:', data);

              // --- SCENE ENUMERATION HANDLER ---
              if (command[2] === 0x01) {
                // validate ACK
                if (data.length < 2 || data[0] !== 0x00) {
                  this._sceneScanInProgress = false;
                  this._scenesFetchedAt = Date.now();
                  this._notifActive = false;
                  this._sceneLastRequested = null;
                  return;
                }

                const next_scene = data[2];
                const name = data.slice(3).toString().trim();

                // current scene id = last index we asked for
                const currentId = this._sceneLastRequested;

                // push only once per name
                if (currentId !== null && !this._sceneNames.has(name)) {
                  this._scenes.push({ id: currentId, name });
                  this._sceneNames.add(name);
                }

                // end of list
                if (next_scene === 0xFF) {
                  this._sceneScanInProgress = false;
                  this._scenesFetchedAt = Date.now();
                  this._notifActive = false;
                  this._sceneLastRequested = null;
                  return;
                }

                // anti-loop on indexes
                if (this._sceneVisited.has(next_scene)) {
                  this._sceneScanInProgress = false;
                  this._scenesFetchedAt = Date.now();
                  this._notifActive = false;
                  this._sceneLastRequested = null;
                  return;
                }
                this._sceneVisited.add(next_scene);

                // chain next scene on the SAME session
                this._sceneLastRequested = next_scene;
                const nextCmd = Buffer.concat([Buffer.from([0xA0, 0x01, 0x01]), Buffer.from([next_scene])]);
                await sleep(200);
                await service.write(API_CHARACTERISTIC_UUID, nextCmd)
                  .catch(e => this.log('scene write err', e.message));
              }
              // --- END SCENE ENUMERATION HANDLER ---

            });
          } catch (subErr) {
            this._notifActive = false;
            this.log('subscribe error:', subErr.message || subErr);
          }
        }

        // pacing for scenes and setScene
        if (command[2] === 0x01 || command[2] === 0x05) await sleep(300);

        // send command
        await service.write(API_CHARACTERISTIC_UUID, command)
          .catch((error) => { this.log(error.message); });

        // for non-scene writes, update local state without waiting a notif
        if (command[2] === 0x02 || command[2] === 0x03) {
          if (!this.getCapabilityValue('onoff')) await this.setCapabilityValue('onoff', true);
          this._calculatePower();
        } else if (command[2] === 0x05) {
          const turningOff = (command.length >= 4 && command[3] === 0x00);
          const current = !!this.getCapabilityValue('onoff');
          if (turningOff && current) await this.setCapabilityValue('onoff', false);
          else if (!turningOff && !current) await this.setCapabilityValue('onoff', true);
          this._calculatePower();
        }
      }

      this._commandRetry = 0;
      this._commandBusy = false;
      return Promise.resolve(true);

    } catch (error) {
      this._commandBusy = false;
      this.log(error.message);
      this._disconnect();
      return Promise.resolve(true);
    }
  }

  async _api(cmd, data) {
    // this.log('_api', cmd, data); // silence if needed

    // wake scan on interaction; reset backoff
    if (!this._peripheral) {
      this._scanDelayMs = 5_000;
      if (!this._searchTimer) this._searchDevice(0);
    }

    // coalesce identical cmds within 1200ms
    const key = `${cmd}:${data.toString('hex')}`;
    const now = Date.now();
    if (this._lastCmdKey === key && (now - this._lastCmdTs) < 1200) return Promise.resolve(true);
    this._lastCmdKey = key; this._lastCmdTs = now;

    const v = (cmd > 4) ? 0x02 : 0x01;
    this._commandQueue.push(Buffer.concat([Buffer.from([0xA0, v, cmd]), data]));
    await this._processQueue(false).catch(() => null);
    return Promise.resolve(true);
  }

  async _onCapabilityLight(valueObj) {
    if (Object.keys(valueObj).length === 1) {
      if (typeof valueObj.onoff === 'boolean') {
        if (valueObj.onoff === false) return this.setScene({ id: 0x00 });
        return this.setScene({ id: 0xFF });
      } else if (typeof valueObj.dim === 'number') {
        if (!this.getCapabilityValue('onoff')) this.setScene({ id: 0xFF });
        const buf = Buffer.alloc(1); buf.writeUInt8(Math.round(valueObj.dim * 100), 0);
        return this._api(3, buf);
      }
    }

    let {
      dim = this.getCapabilityValue('dim'),
      light_hue = this.getCapabilityValue('light_hue'),
      light_saturation = this.getCapabilityValue('light_saturation'),
      light_mode = this.getCapabilityValue('light_mode'),
      light_temperature = this.getCapabilityValue('light_temperature'),
    } = valueObj;

    if (dim === null) dim = 0.5;
    if (light_hue === null) light_hue = 0;
    if (light_saturation === null) light_saturation = 1;
    if (light_mode === null) light_mode = 'color';
    if (light_temperature === null) light_temperature = 0.5;

    if (!this.getCapabilityValue('onoff')) this.setScene({ id: 0xFF });

    if (Object.keys(valueObj).length === 2 && typeof valueObj.dim === 'number') {
      const buf = Buffer.alloc(1); buf.writeUInt8(Math.round(valueObj.dim * 100), 0);
      return this._api(3, buf);
    }

    if (light_mode === 'color') {
      const buf = Buffer.alloc(7);
      buf.writeUInt8(0x01, 0);
      buf.writeUInt16BE(0x00, 1);
      buf.writeUInt8(Math.round(light_saturation * 255), 3);
      buf.writeUInt16BE(Math.round(light_hue * 65535), 4);
      buf.writeUInt8(Math.round(dim * 100), 6);
      return this._api(2, buf);
    }
    const buf = Buffer.alloc(6);
    buf.writeUInt8(0x02, 0);
    buf.writeUInt16BE(0x00, 1);
    buf.writeUInt16BE(Math.round((1 - light_temperature) * (4000 - 2700) + 2700), 3);
    buf.writeUInt8(Math.round(dim * 100), 5);
    return this._api(2, buf);
  }

  async _calculatePower() {
    if (!this.hasCapability('measure_power')) {
      if (typeof this.addCapability === 'function') {
        await this.addCapability('measure_power');
        await this.setCapabilityOptions('measure_power', { approximated: true });
      } else { return; }
    }
    const { LAMP_WATT_MIN, LAMP_WATT_MAX } = this.constructor;
    let onoff = this.getCapabilityValue('onoff');
    let dim = this.getCapabilityValue('dim');
    if (!onoff) dim = 0;
    const usage = LAMP_WATT_MIN + ((LAMP_WATT_MAX - LAMP_WATT_MIN) * dim);
    this.setCapabilityValue('measure_power', usage).catch(this.error);
  }

  async _getScenes() {
    if (this._sceneScanInProgress) return;
    this._sceneScanInProgress = true;

    this._scenesFetchedAt = Date.now();

    // reset enumeration state
    this._scenes = [];
    this._sceneVisited.clear();
    this._sceneNames.clear();
    this._sceneLastRequested = 0; // start from index 0

    // kick off scene 0; notifications will chain the rest
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x00, 0);
    this._api(1, buf).catch(() => null);
  }

  async getScenesNames() { return this._scenes; }

  async setScene({ id }) {
    const buf = Buffer.alloc(1); buf.writeUInt8(id, 0);
    return this._api(5, buf);
  }
}

module.exports = SmartLampDevice;
