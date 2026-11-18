/**
 * =========================================================================
 * PetLink - Reminder service (hub -> device commands)
 * =========================================================================
 * Revised plan, MVP item 7: "Reminders pushed from the backend to the band".
 *
 *  - Reminders (habit, time of day, text) are stored in SQLite, so times can
 *    be changed through the API without re-flashing the ESP32.
 *  - A scheduler checks every few seconds; at the reminder time it publishes
 *    a command under the plan's command topic, one sub-topic per habit:
 *        petlink/{device_id}/cmd/reminder/{habit_id}
 *      { "type":"reminder", "id":"rem-3-2026-11-19-1000", "habit_id":"water",
 *        "text":"Drink water!", "remaining":2, "buzz":true,
 *        "expires": 1763560000, "ts": 1763552800 }
 *  - PRIVACY: the station is shared, so the command carries only a COUNT of
 *    players still to do the habit, never names. Personal to-do lists are
 *    shown only after a player taps their own RFID card (see mqttService).
 *  - "only if not done": skipped if everyone already did the habit today.
 *    As players log it, "reminder_update" lowers the count on the station;
 *    once everyone is done an EMPTY retained message clears it.
 *  - The command is RETAINED, so a station that is offline at reminder time
 *    gets it as soon as it reconnects. The broker keeps one retained message
 *    per topic, so each habit has its own topic: updating the water reminder
 *    can't overwrite the reading reminder. `expires` stops a stale reminder from
 *    showing hours later, and `id` lets the ESP32 ignore repeats.
 * =========================================================================
 */
const { db, getLocalDateString, getAllPlayersWithPets, getHabitById } = require('../database/db');
const reliability = require('./deviceReliability');

const CHECK_INTERVAL_MS = Number(process.env.REMINDER_CHECK_MS) || 15000;
const EXPIRY_S = Number(process.env.REMINDER_EXPIRY_S) || 2 * 3600;    // stale after 2 h
const DEFAULT_DEVICE = process.env.STATION_DEVICE_ID || 'esp32_petlink_station';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id         TEXT NOT NULL,
    time_hhmm        TEXT NOT NULL,
    text             TEXT NOT NULL,
    only_if_not_done INTEGER NOT NULL DEFAULT 1,
    buzz             INTEGER NOT NULL DEFAULT 1,
    enabled          INTEGER NOT NULL DEFAULT 1,
    last_sent_date   TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Default reminders (only on a brand-new database)
if (db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n === 0) {
  const ins = db.prepare('INSERT INTO reminders (habit_id, time_hhmm, text) VALUES (?, ?, ?)');
  [['water', '10:00', 'Drink water!'], ['water', '15:00', 'Drink water!'],
   ['exercise', '18:00', 'Time to move!'], ['reading', '21:00', 'Read a few pages!']]
    .forEach(([h, t, txt]) => { if (getHabitById(h)) ins.run(h, t, txt); });
  console.log('[REMINDER] Seeded default reminders.');
}

const q = {
  all: db.prepare('SELECT * FROM reminders ORDER BY time_hhmm, id'),
  byId: db.prepare('SELECT * FROM reminders WHERE id = ?'),
  dueNow: db.prepare('SELECT * FROM reminders WHERE enabled = 1 AND time_hhmm = ? AND (last_sent_date IS NULL OR last_sent_date <> ?)'),
  markSent: db.prepare('UPDATE reminders SET last_sent_date = ? WHERE id = ?'),
  insert: db.prepare(`INSERT INTO reminders (habit_id, time_hhmm, text, only_if_not_done, buzz, enabled)
                      VALUES (@habit_id, @time_hhmm, @text, @only_if_not_done, @buzz, @enabled)`),
  remove: db.prepare('DELETE FROM reminders WHERE id = ?')
};

const toApi = (r) => r && ({
  id: r.id, habitId: r.habit_id, time: r.time_hhmm, text: r.text,
  onlyIfNotDone: !!r.only_if_not_done, buzz: !!r.buzz, enabled: !!r.enabled,
  lastSentDate: r.last_sent_date
});

/** Check + normalise user input. Returns { value } or { error }. */
function validate(input, { partial = false } = {}) {
  const out = {};
  if (input.habitId !== undefined || !partial) {
    if (typeof input.habitId !== 'string' || !getHabitById(input.habitId)) return { error: 'habitId must be an existing habit id' };
    out.habit_id = input.habitId;
  }
  if (input.time !== undefined || !partial) {
    if (typeof input.time !== 'string' || !TIME_RE.test(input.time)) return { error: 'time must be "HH:MM" (24-hour)' };
    out.time_hhmm = input.time;
  }
  if (input.text !== undefined || !partial) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 40) return { error: 'text must be 1-40 characters' };
    out.text = input.text.trim();
  }
  for (const [k, col] of [['onlyIfNotDone', 'only_if_not_done'], ['buzz', 'buzz'], ['enabled', 'enabled']]) {
    if (input[k] !== undefined) {
      if (typeof input[k] !== 'boolean') return { error: `${k} must be true or false` };
      out[col] = input[k] ? 1 : 0;
    } else if (!partial) {
      out[col] = 1;
    }
  }
  return { value: out };
}

const hhmmNow = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

class ReminderService {
  constructor(mqttService, io) {
    this.mqtt = mqttService;
    this.io = io;
    this.timer = null;
    this.active = new Map();   // habit_id -> { id, text, expires, buzz } for reminders currently showing
  }

  /** How many players have NOT logged this habit today (no names: shared screen). */
  remainingFor(habitId) {
    return getAllPlayersWithPets().filter((p) => !(p.completed_today || []).includes(habitId)).length;
  }

  /**
   * Publish to petlink/{device}/cmd/reminder/{habit} on every station.
   * command = null -> empty retained message = "clear this reminder".
   */
  publish(habitId, command) {
    if (!this.mqtt.client || !this.mqtt.connected) return [];
    const devices = this.targetDevices();
    for (const dev of devices) {
      // retain: a station that is offline right now gets the latest state when it reconnects
      this.mqtt.client.publish(`petlink/${dev}/cmd/reminder/${habitId}`,
        command ? JSON.stringify(command) : '', { qos: 1, retain: true });
    }
    return devices;
  }

  /**
   * Called after any habit is logged. If a reminder for that habit is active,
   * update the anonymous "N to go" count on the station, or clear it at 0.
   */
  onHabitLogged(habitId) {
    const a = this.active.get(habitId);
    if (!a) return;
    const nowS = Math.floor(Date.now() / 1000);
    if (nowS > a.expires) { this.active.delete(habitId); return; }

    const remaining = this.remainingFor(habitId);
    const command = remaining > 0
      ? { type: 'reminder_update', id: a.id, habit_id: habitId, text: a.text, remaining, ts: nowS, expires: a.expires }
      : { type: 'reminder_clear', id: a.id, habit_id: habitId, ts: nowS };
    if (remaining === 0) this.active.delete(habitId);
    const devices = this.publish(habitId, remaining > 0 ? command : null);
    console.log(`[REMINDER] ${habitId}: ${remaining > 0 ? `${remaining} still to go` : 'everyone done, reminder cleared'} (${devices.join(', ') || 'broker offline'})`);
    if (this.io) this.io.emit('reminder_update', command);
  }

  start() {
    this.timer = setInterval(() => this.checkDue(), CHECK_INTERVAL_MS);
    console.log(`[REMINDER] Scheduler started (checks every ${CHECK_INTERVAL_MS / 1000}s, ${q.all.all().length} reminder(s)).`);
  }

  stop() { clearInterval(this.timer); }

  list() { return q.all.all().map(toApi); }
  get(id) { return toApi(q.byId.get(id)); }

  create(input) {
    const v = validate(input);
    if (v.error) return v;
    const info = q.insert.run(v.value);
    return { value: this.get(info.lastInsertRowid) };
  }

  update(id, input) {
    if (!q.byId.get(id)) return { error: 'not found', status: 404 };
    const v = validate(input, { partial: true });
    if (v.error) return v;
    const cols = Object.keys(v.value);
    if (cols.length) {
      // only whitelisted column names reach this SQL (they come from validate())
      db.prepare(`UPDATE reminders SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, last_sent_date = NULL WHERE id = @id`)
        .run({ ...v.value, id });
    }
    return { value: this.get(id) };
  }

  remove(id) {
    return q.remove.run(id).changes > 0;
  }

  /** Devices to send to: every station the hub has seen, or the default id. */
  targetDevices() {
    const ids = reliability.listDevices().map((d) => d.device_id);
    return ids.length ? ids : [DEFAULT_DEVICE];
  }

  /** Called by the scheduler: send every reminder whose time is now. */
  checkDue(now = new Date()) {
    const today = getLocalDateString();
    for (const r of q.dueNow.all(hhmmNow(now), today)) {
      q.markSent.run(today, r.id);            // mark first: never send twice in one day
      this.send(r, { reason: 'scheduled' });
    }
  }

  /**
   * Build and publish the reminder command.
   * Returns { sent, skipped, command, devices }.
   */
  send(reminderRow, { reason = 'manual', force = false } = {}) {
    const r = reminderRow;
    const habit = getHabitById(r.habit_id);
    const remaining = this.remainingFor(r.habit_id);

    if (r.only_if_not_done && remaining === 0 && !force) {
      console.log(`[REMINDER] "${r.text}" skipped: everyone already did ${r.habit_id} today.`);
      return { sent: false, skipped: 'everyone_done' };
    }

    const nowS = Math.floor(Date.now() / 1000);
    const command = {
      type: 'reminder',
      id: `rem-${r.id}-${getLocalDateString()}-${reason === 'scheduled' ? r.time_hhmm.replace(':', '') : nowS}`,
      habit_id: r.habit_id,
      habit_name: habit ? habit.name : r.habit_id,
      text: r.text,
      remaining,                     // a count only: no names on a shared screen
      buzz: !!r.buzz,
      ts: nowS,
      expires: nowS + EXPIRY_S
    };

    if (!this.mqtt.client || !this.mqtt.connected) {
      console.warn(`[REMINDER] "${r.text}" not sent: backend is not connected to the MQTT broker.`);
      return { sent: false, skipped: 'broker_offline', command };
    }

    const devices = this.publish(r.habit_id, command);
    this.active.set(r.habit_id, { id: command.id, text: command.text, expires: command.expires, buzz: command.buzz });
    console.log(`[REMINDER] Sent "${r.text}" (${reason}) to ${devices.join(', ')}, ${remaining} player(s) still to go`);
    if (this.io) this.io.emit('reminder_sent', { ...command, devices, reason });
    return { sent: true, command, devices };
  }
}

module.exports = { ReminderService, TIME_RE };
