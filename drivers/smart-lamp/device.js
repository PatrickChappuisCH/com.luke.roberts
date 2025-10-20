'use strict';

const Homey = require('homey');

// small utils
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Device firmware idles BLE after ~8s; driver should not force disconnects
const COMMAND_QUEUE_RETRY = 4;
const BLE_DISCONNECT_TIMEOUT = 0;
const BLE_SEARCH_TIMEOUT = 30;

const {
  SERVICE_UUID,
  API_CHARACTERISTIC_UUID,
} = require('../../config');

class SmartLampDevice extends Homey.Device {

  static get LAMP_WATT_MIN() { return 0.5; }
  static get LAMP_WATT_MAX() { return 75; }

  async onInit() {
    this.log('SmartLampDevice has been inited');
    this.setUnavailable();

    this.registerMultipleCapabilityListener([
      'onoff',
      'dim',
      'light_hue',
      'light_saturation',
      'light_mode',
      'light_temperature'
    ], this._onCapabilityLight.bind(this), 300);

    this._device = null;
    this._peripheral = null;

    this._connectionTimer = null;
    this._commandBusy = false;
    this._commandQueue = [];
    this._commandRetry = 0;
    this._scenes = [];

    // anti-duplicate scan timer
    this._searchTimer = null;

    // exponential backoff state (Option 2)
    this._scanDelayMs = 5_000;     // start at 5s
    this._scanDelayMax = 300_000;  // cap at 5min

    // coalescing state (avoid stacking identical commands during blackout)
    this._lastCmdKey = null;
    this._lastCmdTs = 0;

    // scenes fetch throttling
    this._sceneScanInProgress = false;
    this._scenesFetchedAt = 0;
    this._scenesTtlMs = 10 * 60 * 1000; // 10 minutes

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

    // reset backoff on successful discovery/connection
    this._scanDelayMs = 5_000;
  }

  async _searchDevice(timeout) {
    if (this._searchTimer) clearTimeout(this._searchTimer);

    this._searchTimer = setTimeout(async () => {
      this._searchTimer = null;

      const { id } = this.getData();
      let adv = null;
      try {
        adv = await this.homey.ble.find(id);
      } catch (e) {
        // expected when the lamp is not advertising; log and continue
        this.log('BLE find failed:', e.statusCode || e.message || e);
      }

      if (adv && adv.id === id) {
        this._device = adv;
        try {
          await this._onDeviceInit();
        } catch (err) {
          this.error(err);
        }
      } else {
        // exponential backoff when not found
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
    if (this._connectionTimer) {
      clearTimeout(this._connectionTimer);
      this._connectionTimer = null;
    }
  }

  async _getService() {
    // already connected
    if (this._peripheral && this._peripheral.isConnected) {
      this.log('_getService already connected');
      this._connectionTimerStop();
      const BLEservice = await this._peripheral.getService(SERVICE_UUID);
      return Promise.resolve(BLEservice);
    }

    // in-progress connection
    if (this._connectionTimer) {
      this.log('_getService connection already started');
      this._connectionTimerStop();
      return Promise.resolve(null);
    }

    // start connection
    this.log('_getService connecting');
    this._connectionTimerStop();

    // refresh advertisement right before connect() to avoid stale handles
    try {
      const fresh = await this.homey.ble.find(this.getData().id);
      if (fresh) this._device = fresh;
      else return null;
    } catch (_) {
      return null;
    }

    try {
      this._peripheral = await this._device.connect();

      // purge caches on disconnect to force a fresh find()
      this._peripheral.once('disconnect', async () => {
        this._peripheral = null;
        this._device = null;
        this._disconnect();
      });

      await this._peripheral.discoverAllServicesAndCharacteristics();
      const BLEservice = await this._peripheral.getService(SERVICE_UUID);
      if (!BLEservice) {
        this.log('_getService missing service');
        return Promise.reject(new Error('missing_service'));
      }

      // allow GATT to settle slightly after discovery
      await sleep(200);

      return Promise.resolve(BLEservice);

    } catch (e) {
      this.log('_getService connect fail:', e.message);
      // purge caches on failure
      this._peripheral = null;
      this._device = null;

      // schedule next scan using backoff
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
      this.log('_disconnect peripheral');
      await this._peripheral.disconnect().catch(() => null);
    }

    this._commandBusy = false;
    delete this._peripheral;

    // resume queue safely
    setTimeout(() => { this._processQueue(true).catch(() => null); }, 500);

    // schedule next scan using backoff (Option 2)
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

    if (this._commandQueue.length === 0) {
      this.log('_processQueue empty');
      return Promise.resolve(true);
    }

    try {
      if (this._commandBusy) {
        this.log('_processQueue is busy');
        return Promise.resolve(true);
      }

      this._commandBusy = true;

      const service = await this._getService().catch((error) => this.log(error));
      if (!service) {
        this.log('_processQueue service missing');
        // schedule a retry but NEVER throw
        setTimeout(() => { this._processQueue(true).catch(() => null); }, 500);
        this._commandBusy = false;
        return Promise.resolve(true);
      }

      while (this._commandQueue.length > 0) {
        this._connectionTimerStop();
        const command = this._commandQueue.shift();

        // guard to avoid writing too early right after reconnect
        await sleep(100); // was 50ms

        this.log('_processQueue writing', command);

        const characteristic = await service.getCharacteristic(API_CHARACTERISTIC_UUID);

        // avoid crash "No notify session started" if 2 notifications fire
        let handled = false;

        await characteristic.subscribeToNotifications(async (data) => {
          if (handled) return;
          handled = true;

          this.log('_processQueue notification:', data);

          // Scenes readout
          if (command[2] === 0x01) {
            if (data.length < 2 || data[0] !== 0x00) {
              characteristic.unsubscribeFromNotifications().catch(() => null);
              return;
            }

            const next_scene = data[2];
            const name = data.slice(3).toString().trim();
            this._scenes.push({ id: command[3], name });

            if (next_scene !== 0xFF) {
              const b = Buffer.alloc(1);
              b.writeUInt8(next_scene, 0);
              this._api(1, b);
            } else {
              // end of enumeration
              this._sceneScanInProgress = false;
              this._scenesFetchedAt = Date.now();
            }

          // Light changes (uplight/downlight/scene)
          } else if (command[2] === 0x02 || command[2] === 0x03 || command[2] === 0x05) {
            // Lamp often ACKs with 0x00 only. Update local state anyway.
            if (command[2] === 0x05) {
              // 0x05 = setScene: 0x00 = OFF, 0xFF = ON
              const turningOff = (command.length >= 4 && command[3] === 0x00);
              const current = !!this.getCapabilityValue('onoff');
              if (turningOff && current) {
                await this.setCapabilityValue('onoff', false);
              } else if (!turningOff && !current) {
                await this.setCapabilityValue('onoff', true);
              }
            } else {
              // 0x02/0x03 imply the lamp is lit
              if (!this.getCapabilityValue('onoff')) {
                await this.setCapabilityValue('onoff', true);
              }
            }
            this._calculatePower();
          }

          // do not await; ignore errors if already closed
          characteristic.unsubscribeFromNotifications().catch(() => null);
        });

        // pacing: scenes enumeration and setScene need extra delay
        if (command[2] === 0x01 || command[2] === 0x05) await sleep(300);

        await service.write(API_CHARACTERISTIC_UUID, command)
          .catch((error) => {
            this.log(error.message);
          });
      }

      this._commandRetry = 0;
      this._commandBusy = false;
      return Promise.resolve(true);

    } catch (error) {
      this._commandBusy = false;
      this.log(error.message);
      this._disconnect();
      // NEVER throw here; timers may call this function
      return Promise.resolve(true);
    }
  }

  // coalescing identical commands sent too close in time (silent)
  async _api(cmd, data) {
    // this.log('_api', cmd, data); // silenced to reduce log noise

    // wake scan immediately on user interaction; reset backoff
    if (!this._peripheral) {
      this._scanDelayMs = 5_000;
      if (!this._searchTimer) this._searchDevice(0);
    }

    // same cmd+payload within 1200ms → skip silently
    const key = `${cmd}:${data.toString('hex')}`;
    const now = Date.now();
    if (this._lastCmdKey === key && (now - this._lastCmdTs) < 1200) {
      return Promise.resolve(true);
    }
    this._lastCmdKey = key;
    this._lastCmdTs = now;

    let v = 0x01;
    if (cmd > 4) v = 0x02;

    this._commandQueue.push(Buffer.concat([Buffer.from([0xA0, v, cmd]), data]));
    await this._processQueue(false).catch(() => null);
    return Promise.resolve(true);
  }

  async _onCapabilityLight(valueObj) {
    // onoff or dim only
    if (Object.keys(valueObj).length === 1) {
      if (typeof valueObj.onoff === 'boolean') {
        if (valueObj.onoff === false) return this.setScene({ id: 0x00 });
        return this.setScene({ id: 0xFF });
      } else if (typeof valueObj.dim === 'number') {
        if (!this.getCapabilityValue('onoff')) this.setScene({ id: 0xFF });
        const buf = Buffer.alloc(1);
        buf.writeUInt8(Math.round(valueObj.dim * 100), 0);
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

    if (!this.getCapabilityValue('onoff'))
      this.setScene({ id: 0xFF });

    // flow dim-only: do not alter colors
    if (Object.keys(valueObj).length === 2 && typeof valueObj.dim === 'number') {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(Math.round(valueObj.dim * 100), 0);
      return this._api(3, buf);
    }

    // Uplight
    if (light_mode === 'color') {
      const buf = Buffer.alloc(7);
      buf.writeUInt8(0x01, 0);          // Flag
      buf.writeUInt16BE(0x00, 1);       // Duration, 0 = infinite
      buf.writeUInt8(Math.round(light_saturation * 255), 3);  // Saturation
      buf.writeUInt16BE(Math.round(light_hue * 65535), 4);    // Hue
      buf.writeUInt8(Math.round(dim * 100), 6);               // Brightness
      return this._api(2, buf);
    }
    // Downlight
    const buf = Buffer.alloc(6);
    buf.writeUInt8(0x02, 0);            // Flag
    buf.writeUInt16BE(0x00, 1);         // Duration, 0 = infinite
    buf.writeUInt16BE(Math.round((1 - light_temperature) * (4000 - 2700) + 2700), 3);
    buf.writeUInt8(Math.round(dim * 100), 5);
    return this._api(2, buf);
  }

  async _calculatePower() {
    // ensure capability exists
    if (!this.hasCapability('measure_power')) {
      if (typeof this.addCapability === 'function') {
        await this.addCapability('measure_power');
        await this.setCapabilityOptions('measure_power', { approximated: true });
      } else {
        return;
      }
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

    this._scenes = [];
    // retrieve first scene, the rest will follow via notifications
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x00, 0);
    this._api(1, buf);
  }

  async getScenesNames() {
    return this._scenes;
  }

  async setScene({ id }) {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(id, 0);
    return this._api(5, buf);
  }
}

module.exports = SmartLampDevice;
