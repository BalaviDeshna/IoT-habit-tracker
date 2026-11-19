const mqtt = require('mqtt');
const petLogic = require('./petLogic');
const db = require('../database/db');
const reliability = require('./deviceReliability');

class MqttService {
  constructor(io, options = {}) {
    this.io = io;
    this.brokerUrl = options.brokerUrl || process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
    this.clientId = options.clientId || `petlink_backend_${Math.random().toString(16).slice(2, 8)}`;
    this.client = null;
    this.connected = false;
    this.idleTimer = null;

    this.TOPICS = {
      LIGHT: 'petlink/habitat/light',
      RFID: 'petlink/device/rfid',
      HABIT: 'petlink/device/habit',
      DISPLAY: 'petlink/device/display',
      STATUS: reliability.STATUS_TOPIC_FILTER,   // petlink/device/status/+
      WEARABLE_EVENTS: 'petlink/+/event',
      ACK: reliability.ACK_TOPIC                 // petlink/device/ack
    };
  }

  connect() {
    console.log(`[MQTT] Connecting to broker at ${this.brokerUrl} (client: ${this.clientId})...`);

    this.client = mqtt.connect(this.brokerUrl, {
      clientId: this.clientId,
      clean: true,
      reconnectPeriod: 3000, // Reconnect every 3 seconds if disconnected
      connectTimeout: 10000,
      ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD || '' } : {})
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log(`[MQTT] Successfully connected to broker: ${this.brokerUrl}`);

      // Subscribe to all incoming device topics
      const subscribeTopics = [this.TOPICS.LIGHT, this.TOPICS.RFID, this.TOPICS.HABIT, this.TOPICS.STATUS, this.TOPICS.WEARABLE_EVENTS];
      this.client.subscribe(subscribeTopics, { qos: 1 }, (err, granted) => {
        if (err) {
          console.error('[MQTT] Subscription error:', err.message);
        } else {
          console.log('[MQTT] Subscribed to topics:', granted.map(g => g.topic).join(', '));
        }
      });

      // Send initial idle screen to display
      this.sendDisplay(petLogic.getIdleDisplayState());

      if (this.io) {
        this.io.emit('mqtt_status', { connected: true, broker: this.brokerUrl });
      }
    });

    this.client.on('reconnect', () => {
      console.log('[MQTT] Attempting reconnection to MQTT broker...');
      if (this.io) {
        this.io.emit('mqtt_status', { connected: false, reconnecting: true, broker: this.brokerUrl });
      }
    });

    this.client.on('close', () => {
      if (this.connected) {
        console.warn('[MQTT] Connection closed.');
      }
      this.connected = false;
      if (this.io) {
        this.io.emit('mqtt_status', { connected: false, broker: this.brokerUrl });
      }
    });

    this.client.on('offline', () => {
      console.warn('[MQTT] Client is offline.');
      this.connected = false;
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
    });

    this.client.on('message', (topic, payloadBuffer) => {
      this.handleIncomingMessage(topic, payloadBuffer);
    });
  }

  handleIncomingMessage(topic, payloadBuffer) {
    let payload;
    const rawString = payloadBuffer.toString();

    // 1. JSON parsing and basic validation
    try {
      payload = JSON.parse(rawString);
    } catch (e) {
      console.warn(`[MQTT] Received invalid JSON on [${topic}]: "${rawString}"`);
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      console.warn(`[MQTT] Ignoring non-object payload on [${topic}]`);
      return;
    }

    // Device online/offline (retained status + Last Will)
    if (topic.startsWith(reliability.STATUS_TOPIC_PREFIX)) {
      this.handleStatusMessage(topic, payload);
      return;
    }

    const timestamp = payload.timestamp || payload.ts || Date.now();

    // Revised wearable contract: petlink/{device_id}/event
    const wearableMatch = topic.match(/^petlink\/([^/]+)\/event$/);
    if (wearableMatch) { this.handleWearableEvent(wearableMatch[1], payload); return; }
    const deviceId = payload.deviceId || 'unknown-device';

    // 2. Dispatch according to topic
    switch (topic) {
      case this.TOPICS.LIGHT:
        this.handleLightMessage(payload, deviceId, timestamp);
        break;

      case this.TOPICS.RFID:
        this.handleRfidMessage(payload, deviceId, timestamp);
        break;

      case this.TOPICS.HABIT:
        this.handleHabitMessage(payload, deviceId, timestamp);
        break;

      default:
        console.log(`[MQTT] Unhandled topic: ${topic}`);
    }
  }

  handleLightMessage(payload, deviceId, timestamp) {
    if (payload.lux === undefined || isNaN(Number(payload.lux))) {
      console.warn('[MQTT] [LIGHT] Missing or non-numeric lux field:', payload);
      return;
    }

    const lux = Number(payload.lux);
    const result = petLogic.processLightReading(lux);
    if (!result) return;

    console.log(`[MQTT] [LIGHT] Device ${deviceId} -> ${lux.toFixed(1)} lux => Habitat is ${result.condition}`);

    // Broadcast to frontend
    if (this.io) {
      this.io.emit('habitat_update', {
        lux: result.lux,
        condition: result.condition,
        timestamp: result.timestamp,
        deviceId
      });
    }
  }

  handleRfidMessage(payload, deviceId, timestamp) {
    if (!payload.uid) {
      console.warn('[MQTT] [RFID] Missing "uid" in payload:', payload);
      return;
    }

    const uid = String(payload.uid);
    console.log(`[MQTT] [RFID] Scanned card UID: "${uid}" from device: ${deviceId}`);

    const result = petLogic.processRfidScan(uid);

    // The hub RFID scan assigns the shared/demo wearable to this family member.
    // For multiple simultaneous wearers, give each wearable its own device_id and scan at its hub.
    if (result.success) {
      try { db.assignDeviceToPlayer(process.env.DEFAULT_WEARABLE_ID || 'band_01', result.player.id); }
      catch (e) { console.error('[MQTT] Could not assign wearable:', e.message); }
    }

    // PRIVACY: personal to-do list, only after the player identified themselves
    // with their own card. Shown briefly on the station before the habit menu.
    if (result.success && result.display) {
      const todo = db.getHabits()
        .filter((h) => !(result.completedToday || []).includes(h.id))
        .map((h) => h.name);
      result.display.todo = todo.length ? todo.join(', ') : 'All done today!';
    }

    // Send display instructions to ESP32 OLED
    this.sendDisplay(result.display);

    // Broadcast to web frontend
    if (this.io) {
      if (result.success) {
        this.io.emit('rfid_scanned', {
          success: true,
          player: result.player,
          completedToday: result.completedToday,
          deviceId,
          timestamp: new Date().toISOString()
        });
      } else {
        this.io.emit('rfid_scanned', {
          success: false,
          notFound: true,
          uid: result.uid,
          deviceId,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Reset back to idle screen after 25 seconds of inactivity
    this.scheduleIdleReset(25000);
  }

  handleStatusMessage(topic, payload) {
    const status = reliability.updateStatus(topic, payload);
    if (!status) {
      console.warn(`[DEVICE] Invalid status message on [${topic}]:`, payload);
      return;
    }
    if (status.online) {
      const pending = status.pending ? `, ${status.pending} event(s) to sync` : '';
      console.log(`[DEVICE] ${status.deviceId} is ONLINE (${status.ip || 'no ip'}${pending})`);
    } else {
      console.warn(`[DEVICE] ${status.deviceId} is OFFLINE (${status.reason})`);
    }
    if (this.io) this.io.emit('device_status', status);
  }

  // Tell the ESP32 its event is safely processed, so it can delete it from flash.
  sendAck(deviceId, eventId, outcome) {
    if (!this.client || !this.connected) return;
    const payload = JSON.stringify({ deviceId, eventId, outcome, timestamp: Date.now() });
    this.client.publish(this.TOPICS.ACK, payload, { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] Failed to publish ACK:', err.message);
    });
  }

  handleHabitMessage(payload, deviceId, timestamp) {
    const { uid, habit } = payload;
    if (!uid || !habit) {
      console.warn('[MQTT] [HABIT] Missing uid or habit in payload:', payload);
      return;
    }

    // ---- Store-and-forward: dedup by eventId (events from older firmware have none) ----
    const eventId = payload.eventId;
    if (eventId !== undefined && !reliability.isValidEventId(eventId)) {
      console.warn('[MQTT] [HABIT] Invalid eventId, ignoring message:', eventId);
      return;
    }
    if (eventId) {
      const previous = reliability.findEvent(eventId);
      if (previous) {
        console.log(`[MQTT] [HABIT] Duplicate event ${eventId} ignored (already ${previous.result}). Re-sending ACK.`);
        this.sendAck(deviceId, eventId, 'duplicate');
        return;
      }
    }
    const replayed = payload.replayed === true;
    const { logDate, usedEventTime } = reliability.resolveLogDate(payload.ts);

    console.log(`[MQTT] [HABIT] Submission -> Player UID: "${uid}", Habit: "${habit}" (Device: ${deviceId}` +
      `${eventId ? `, event ${eventId}` : ''}${replayed ? ', synced from offline queue' : ''}` +
      `${usedEventTime ? `, done on ${logDate}` : ''})`);

    let result;
    try {
      result = petLogic.processHabitSubmission(uid, habit, logDate);
    } catch (err) {
      console.error('[MQTT] [HABIT] Processing failed:', err.message);
      result = { success: false, error: err.message, display: { status: 'error', line1: 'HUB ERROR', line2: 'Habit not logged', line3: '', line4: '' } };
    }

    // Remember + ACK, so the ESP32 deletes it from flash and never resends it.
    // Rejected events are ACKed too: retrying them would never succeed.
    if (eventId) {
      const outcome = result.success ? 'logged' : result.duplicate ? 'already_done' : 'rejected';
      reliability.recordEvent({
        eventId, deviceId, kind: 'habit', ts: Number(payload.ts) || null,
        tsSource: payload.tsSource, replayed, result: outcome
      });
      this.sendAck(deviceId, eventId, outcome);
    }

    // Let reminders update their anonymous "N still to go" count
    if (result.success && typeof this.onHabitLogged === 'function') {
      try { this.onHabitLogged(result.habit.id); } catch (e) { console.error('[REMINDER] update failed:', e.message); }
    }

    // Send feedback to ESP32 OLED (not for queued events: nobody is waiting at the
    // station for those, the ESP32 shows its own "SYNC COMPLETE" message instead)
    if (!replayed) {
      this.sendDisplay(result.display);
    }

    // Broadcast to frontend
    if (this.io) {
      if (result.success) {
        this.io.emit('habit_completed', {
          success: true,
          leveledUp: result.leveledUp,
          player: result.player,
          habit: result.habit,
          awarded: result.awarded,
          message: result.message,
          allPlayers: db.getAllPlayersWithPets(),
          recentLogs: db.getRecentLogs(10),
          deviceId,
          eventId: eventId || null,
          replayed,
          logDate,
          timestamp: new Date().toISOString()
        });
      } else if (result.duplicate) {
        this.io.emit('habit_duplicate', {
          success: false,
          duplicate: true,
          player: result.player,
          habit: result.habit,
          message: result.display.line3,
          deviceId,
          timestamp: new Date().toISOString()
        });
      } else {
        this.io.emit('habit_error', {
          success: false,
          error: result.error || 'Failed to process habit',
          deviceId
        });
      }
    }

    // Reset back to idle screen after 15 seconds
    if (!replayed) this.scheduleIdleReset(15000);
  }

  handleWearableEvent(deviceId, payload) {
    const eventId = payload.event_id || payload.eventId;
    if (!eventId || !reliability.isValidEventId(eventId)) {
      console.warn('[WEARABLE] Missing/invalid event_id'); return;
    }
    const previous = reliability.findEvent(eventId);
    if (previous) { this.sendAck(deviceId, eventId, 'duplicate'); return; }

    const player = db.getPlayerByDeviceId(deviceId);
    if (!player) {
      // Do not ACK: keep the event in the wearable's flash queue until an RFID scan assigns a player.
      if (this.io) this.io.emit('wearable_error', { deviceId, error: 'No player assigned. Scan that player\'s RFID card at the hub first.' });
      return;
    }

    const habitId = String(payload.habit_id || '');
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const { logDate } = reliability.resolveLogDate(payload.ts);
    let result;
    try {
      if (habitId === 'outdoor_walk') {
        const steps = Number(data.steps || 0);
        const lux = Number(data.avg_lux || 0);
        const uv = Number(data.max_uv || 0);
        const daytime = payload.daytime !== false;
        const verified = payload.verified === true && steps >= 600 && daytime && (uv > 0.2 || lux >= 5000);
        if (!verified) {
          result = { success: false, error: 'Outdoor Walk verification thresholds not met' };
        } else {
          result = db.recordHabitCompletion(player.id, 'outdoor_walk', logDate);
        }
      } else if (['water', 'meals', 'mood'].includes(habitId)) {
        result = db.recordHabitCompletion(player.id, habitId, logDate);
      } else {
        result = { success: false, error: `Unsupported wearable habit: ${habitId}` };
      }
    } catch (err) { result = { success: false, error: err.message }; }

    const outcome = result.success ? 'logged' : result.duplicate ? 'already_done' : 'rejected';
    reliability.recordEvent({ eventId, deviceId, kind: habitId || 'wearable', ts: Number(payload.ts) || null, tsSource: payload.ts_source, replayed: !!payload.replayed, result: outcome });
    this.sendAck(deviceId, eventId, outcome);

    if (result.success) {
      const updated = db.getPlayerById(player.id);
      if (this.io) this.io.emit('habit_completed', { success: true, player: updated, habit: result.habit, awarded: result.awarded, allPlayers: db.getAllPlayersWithPets(), recentLogs: db.getRecentLogs(10), deviceId, eventId, replayed: !!payload.replayed, logDate });
    } else if (this.io) {
      this.io.emit('wearable_event_result', { deviceId, playerId: player.id, habitId, success: false, duplicate: !!result.duplicate, error: result.error || result.message || 'Already completed' });
    }
  }

  sendDisplay(displayData) {
    if (!this.client || !this.connected) {
      console.warn('[MQTT] Cannot send display: client not connected to broker.');
      return;
    }

    const payload = JSON.stringify({
      status: displayData.status || 'info',
      line1: (displayData.line1 || '').slice(0, 20),
      line2: (displayData.line2 || '').slice(0, 20),
      line3: (displayData.line3 || '').slice(0, 20),
      line4: (displayData.line4 || '').slice(0, 20),
      ...(typeof displayData.todo === 'string' ? { todo: displayData.todo.slice(0, 60) } : {}),
      timestamp: Date.now()
    });

    this.client.publish(this.TOPICS.DISPLAY, payload, { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT] Failed to publish display update:', err.message);
      } else {
        console.log(`[MQTT] Published to [${this.TOPICS.DISPLAY}]: "${displayData.line1}" / "${displayData.line2}"`);
      }
    });

    // Also mirror to web clients so frontend has a live virtual OLED preview!
    // (without the personal to-do list: the website is shared too)
    if (this.io) {
      const { todo, ...shared } = displayData;
      this.io.emit('device_display', shared);
    }
  }

  scheduleIdleReset(delayMs = 20000) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      console.log('[MQTT] Returning station display to IDLE state.');
      this.sendDisplay(petLogic.getIdleDisplayState());
    }, delayMs);
  }
}

module.exports = MqttService;
