/**
 * PetLink - Store-and-forward reliability tests
 * ---------------------------------------------
 * Pretends to be the ESP32 station and checks the backend side of offline sync.
 * Starts its OWN backend on a temporary database, so your real data is untouched.
 *
 * Needs: Mosquitto running (same broker as .env MQTT_BROKER_URL).
 * IMPORTANT: stop the normal backend (npm start) first, otherwise it would also
 * receive these test events and write them into the real database.
 *
 * Run:   npm run test:reliability
 * Output: PASS/FAIL per test + tests/results/reliability-<timestamp>.csv
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const mqtt = require('mqtt');

const BROKER = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
const PORT = 3999;
const DEVICE = 'test_station';
const T = { HABIT: 'petlink/device/habit', ACK: 'petlink/device/ack', STATUS: `petlink/device/status/${DEVICE}` };
const UIDS = ['A1B2C3D4', 'E5F6A7B8', 'C9D0E1F2', '3A4B5C6D'];   // default seeded players
const HABITS = ['water', 'exercise', 'reading'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let seq = 0;

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}  -  ${detail}`);
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 8000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

function makeEvent(uid, habit, { tsOffsetS = 0, replayed = false } = {}) {
  seq++;
  return {
    eventId: `${DEVICE}-${String(seq).padStart(8, '0')}`,
    uid, habit, deviceId: DEVICE,
    ts: Math.floor(Date.now() / 1000) + tsOffsetS,
    tsSource: 'ntp', timestamp: seq, replayed
  };
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function startBackend(dbPath) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, MQTT_CLIENT_ID: `petlink_test_backend_${process.pid}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const ok = await waitFor(() => log.includes('Subscribed to topics'), 15000);
  if (!ok) {
    child.kill();
    throw new Error(`Backend did not connect to the broker at ${BROKER}.\n--- backend log ---\n${log}`);
  }
  return { child, getLog: () => log };
}

async function main() {
  console.log(`\nPetLink reliability tests  (broker ${BROKER})\n`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-test-'));
  const backend = await startBackend(path.join(tmpDir, 'test.db'));

  // Fake ESP32 station
  const acks = [];
  const station = mqtt.connect(BROKER, { clientId: `${DEVICE}_${process.pid}`, reconnectPeriod: 0 });
  await new Promise((res, rej) => { station.on('connect', res); station.on('error', rej); });
  await new Promise((res) => station.subscribe(T.ACK, { qos: 1 }, res));
  station.on('message', (topic, buf) => {
    if (topic !== T.ACK) return;
    const m = JSON.parse(buf.toString());
    if (m.deviceId === DEVICE) acks.push({ ...m, at: Date.now() });
  });
  const send = (ev) => station.publish(T.HABIT, JSON.stringify(ev), { qos: 1 });
  const acksFor = (id) => acks.filter((a) => a.eventId === id);
  const xpOf = async (uid) => (await getJson('/api/state')).data.players.find((p) => p.rfid_uid === uid).pet.xp;

  try {
    // 1. Same event delivered 3 times -> counted once, ACKed every time
    {
      const ev = makeEvent(UIDS[0], 'water');
      const xp0 = await xpOf(UIDS[0]);
      for (let i = 0; i < 3; i++) { send(ev); await sleep(150); }
      await waitFor(() => acksFor(ev.eventId).length >= 3);
      const xp1 = await xpOf(UIDS[0]);
      const outcomes = acksFor(ev.eventId).map((a) => a.outcome).join(',');
      record('Duplicate delivery is counted once', xp1 - xp0 === 15 && acksFor(ev.eventId).length === 3,
        `3 copies sent, XP +${xp1 - xp0} (expected +15), ACK outcomes: ${outcomes}`);
    }

    // 2. Offline backlog of 6 events arrives in a burst -> all logged exactly once
    let backlog;
    {
      backlog = [];
      for (const uid of [UIDS[1], UIDS[2]]) for (const h of HABITS) backlog.push(makeEvent(uid, h, { tsOffsetS: -600, replayed: true }));
      backlog.forEach(send);
      await waitFor(() => backlog.every((e) => acksFor(e.eventId).length >= 1));
      const logged = backlog.filter((e) => acksFor(e.eventId)[0]?.outcome === 'logged').length;
      record('Offline backlog syncs with no loss', logged === backlog.length,
        `${logged}/${backlog.length} queued events logged`);
    }

    // 3. Whole backlog re-sent (e.g. ESP32 rebooted before the ACKs arrived) -> nothing doubles
    {
      const xpBefore = (await xpOf(UIDS[1])) + (await xpOf(UIDS[2]));
      backlog.forEach(send);
      await waitFor(() => backlog.every((e) => acksFor(e.eventId).length >= 2));
      const xpAfter = (await xpOf(UIDS[1])) + (await xpOf(UIDS[2]));
      const dupAcks = backlog.filter((e) => acksFor(e.eventId)[1]?.outcome === 'duplicate').length;
      record('Re-sent backlog is not double counted', xpAfter === xpBefore && dupAcks === backlog.length,
        `XP change ${xpAfter - xpBefore} (expected 0), ${dupAcks}/${backlog.length} recognised as duplicates`);
    }

    // 4. Habit done yesterday (offline), synced today -> counts for yesterday
    {
      const ev = makeEvent(UIDS[3], 'reading', { tsOffsetS: -24 * 3600, replayed: true });
      send(ev);
      await waitFor(() => acksFor(ev.eventId).length >= 1);
      const logs = (await getJson('/api/state')).data.recentLogs;
      const yesterday = localDate(new Date(Date.now() - 24 * 3600 * 1000));
      const row = logs.find((l) => l.log_date === yesterday);
      record('Offline event keeps its real date', !!row,
        `expected log_date ${yesterday}, got ${row ? row.log_date : logs.map((l) => l.log_date).join('/') || 'none'}`);
    }

    // 5. Last Will: station dies without saying goodbye -> backend marks it offline
    {
      const willMsg = JSON.stringify({ deviceId: DEVICE, online: false, reason: 'connection_lost' });
      const dev = mqtt.connect(BROKER, {
        clientId: `${DEVICE}_lwt_${process.pid}`, keepalive: 5, reconnectPeriod: 0,
        will: { topic: T.STATUS, payload: willMsg, qos: 1, retain: true }
      });
      await new Promise((res) => dev.on('connect', res));
      dev.publish(T.STATUS, JSON.stringify({ deviceId: DEVICE, online: true, ip: '10.0.0.42', pending: 0 }), { qos: 1, retain: true });
      const online = await waitFor(async () => (await getJson('/api/devices')).data.devices.find((d) => d.device_id === DEVICE && d.online));
      const killedAt = Date.now();
      dev.stream.destroy();        // simulate power cut: no clean DISCONNECT
      const offline = await waitFor(async () => (await getJson('/api/devices')).data.devices.find((d) => d.device_id === DEVICE && !d.online), 20000);
      const secs = ((Date.now() - killedAt) / 1000).toFixed(1);
      record('Last Will marks a dead station offline', !!online && !!offline,
        offline ? `online seen, offline detected ${secs} s after the connection died` : 'offline status never arrived');
      station.publish(T.STATUS, '', { retain: true });   // clear retained test status
    }

    // 6. Latency: publish -> backend processed -> ACK back at the station
    {
      const times = [];
      for (let i = 0; i < 20; i++) {
        const ev = makeEvent(UIDS[i % 4], HABITS[i % 3]);   // mostly "already_done": still a full round trip
        const t0 = Date.now();
        send(ev);
        const ack = await waitFor(() => acksFor(ev.eventId)[0], 5000, 5);
        if (ack) times.push(ack.at - t0);
      }
      times.sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b, 0) / (times.length || 1);
      record('Round-trip latency (event -> ACK)', times.length === 20,
        `n=${times.length}, avg ${avg.toFixed(1)} ms, median ${times[Math.floor(times.length / 2)]} ms, max ${times[times.length - 1]} ms`);
    }
  } finally {
    station.end(true);
    backend.child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // CSV for the report
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `reliability-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const csv = ['test,result,detail', ...results.map((r) => `"${r.name}",${r.pass ? 'PASS' : 'FAIL'},"${r.detail.replace(/"/g, "'")}"`)].join('\n');
  fs.writeFileSync(file, csv + '\n');

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed. Results saved to ${path.relative(process.cwd(), file)}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest run failed:', err.message);
  process.exit(1);
});
