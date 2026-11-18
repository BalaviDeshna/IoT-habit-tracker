/**
 * =========================================================================
 * PetLink - Device reliability (backend side of store-and-forward)
 * =========================================================================
 * 1. Deduplication: every habit event from the ESP32 has a unique eventId.
 *    We remember each processed id in `device_events`. If the same event
 *    arrives again (the ESP32 retried because an ACK got lost), we ignore it
 *    and just ACK again. This makes retries safe ("idempotent").
 *
 * 2. Event time: events saved offline are synced later. We use the time the
 *    habit was actually done (event `ts`, from NTP on the ESP32) to decide
 *    which day it counts for, not the time it arrived.
 *
 * 3. Device status: the ESP32 publishes a retained online/offline message on
 *    petlink/device/status/<deviceId>, with an MQTT Last Will for "offline".
 *    We store it in `device_status` and push it to the website.
 * =========================================================================
 */
const { db } = require('../database/db');

const STATUS_TOPIC_PREFIX = 'petlink/device/status/';
const ACK_TOPIC = 'petlink/device/ack';

// Accept event timestamps up to 7 days old and at most 5 min in the future
const MAX_EVENT_AGE_S = 7 * 24 * 3600;
const MAX_CLOCK_SKEW_S = 5 * 60;

db.exec(`
  CREATE TABLE IF NOT EXISTS device_events (
    event_id    TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    event_ts    INTEGER,
    ts_source   TEXT,
    replayed    INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS device_status (
    device_id   TEXT PRIMARY KEY,
    online      INTEGER NOT NULL,
    reason      TEXT,
    ip          TEXT,
    pending     INTEGER,
    last_change DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmts = {
  findEvent: db.prepare('SELECT * FROM device_events WHERE event_id = ?'),
  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO device_events (event_id, device_id, kind, event_ts, ts_source, replayed, result)
    VALUES (@eventId, @deviceId, @kind, @ts, @tsSource, @replayed, @result)
  `),
  upsertStatus: db.prepare(`
    INSERT INTO device_status (device_id, online, reason, ip, pending, last_change)
    VALUES (@deviceId, @online, @reason, @ip, @pending, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id) DO UPDATE SET
      online = excluded.online, reason = excluded.reason,
      ip = COALESCE(excluded.ip, device_status.ip),
      pending = excluded.pending, last_change = CURRENT_TIMESTAMP
  `),
  listDevices: db.prepare('SELECT * FROM device_status ORDER BY device_id'),
  eventStats: db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(replayed), 0) AS replayed
    FROM device_events
  `)
};

/** Validates an eventId like "esp32_petlink_station-00000042". */
function isValidEventId(eventId) {
  return typeof eventId === 'string' && /^[A-Za-z0-9_.:-]{3,80}$/.test(eventId);
}

/** Previously processed event with this id, or null. */
function findEvent(eventId) {
  return stmts.findEvent.get(eventId) || null;
}

/** Remember that an event was processed (and what happened). */
function recordEvent({ eventId, deviceId, kind = 'habit', ts = null, tsSource = null, replayed = false, result }) {
  stmts.insertEvent.run({
    eventId,
    deviceId: String(deviceId || 'unknown-device'),
    kind,
    ts: Number.isFinite(ts) ? ts : null,
    tsSource: tsSource ? String(tsSource) : null,
    replayed: replayed ? 1 : 0,
    result: String(result)
  });
}

/** YYYY-MM-DD in the hub's local time for a Date. */
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Which day a habit counts for.
 * Uses the event's own timestamp (unix seconds) when it is believable,
 * otherwise "today" (the arrival time). Returns { logDate, usedEventTime }.
 */
function resolveLogDate(ts, nowMs = Date.now()) {
  const nowS = Math.floor(nowMs / 1000);
  const t = Number(ts);
  const believable = Number.isFinite(t) && t > 1700000000 &&
    t <= nowS + MAX_CLOCK_SKEW_S && t >= nowS - MAX_EVENT_AGE_S;
  if (believable) return { logDate: localDate(new Date(t * 1000)), usedEventTime: true };
  return { logDate: localDate(new Date(nowMs)), usedEventTime: false };
}

/** Parse "petlink/device/status/<id>" -> "<id>" (or null). */
function deviceIdFromStatusTopic(topic) {
  if (!topic.startsWith(STATUS_TOPIC_PREFIX)) return null;
  const id = topic.slice(STATUS_TOPIC_PREFIX.length);
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(id) ? id : null;
}

/** Validate + store a status message. Returns the stored status or null. */
function updateStatus(topic, payload) {
  const deviceId = deviceIdFromStatusTopic(topic);
  if (!deviceId) return null;
  if (typeof payload.online !== 'boolean') return null;

  const status = {
    deviceId,
    online: payload.online ? 1 : 0,
    reason: payload.online ? null : String(payload.reason || 'offline').slice(0, 40),
    ip: typeof payload.ip === 'string' ? payload.ip.slice(0, 45) : null,
    pending: Number.isInteger(payload.pending) ? payload.pending : null
  };
  stmts.upsertStatus.run(status);
  return { ...status, online: !!status.online, lastChange: new Date().toISOString() };
}

function listDevices() {
  return stmts.listDevices.all().map((d) => ({ ...d, online: !!d.online }));
}

function getEventStats() {
  return stmts.eventStats.get();
}

module.exports = {
  STATUS_TOPIC_PREFIX,
  STATUS_TOPIC_FILTER: STATUS_TOPIC_PREFIX + '+',
  ACK_TOPIC,
  isValidEventId,
  findEvent,
  recordEvent,
  resolveLogDate,
  updateStatus,
  listDevices,
  getEventStats
};
