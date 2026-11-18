/**
 * PetLink - Reminder tests (hub -> station commands)
 * --------------------------------------------------
 * Pretends to be the ESP32 station and checks that reminders arrive on
 * petlink/<device_id>/cmd in the right format, on time, only when needed.
 * Starts its OWN backend on a temporary database (your real data is untouched).
 *
 * Needs Mosquitto running. Stop the normal backend (npm start) first.
 * Run:  npm run test:reminders
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const mqtt = require('mqtt');

const BROKER = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
const PORT = 3998;
const DEVICE = 'test_station';
const CMD_TOPIC = `petlink/${DEVICE}/cmd`;                 // reminders: CMD_TOPIC/reminder/<habit>
const HABIT_IDS = ['water', 'exercise', 'reading'];
const STATUS_TOPIC = `petlink/device/status/${DEVICE}`;
const UIDS = ['A1B2C3D4', 'E5F6A7B8', 'C9D0E1F2', '3A4B5C6D'];
const NAMES = ['Alex', 'Bella', 'Charlie', 'Diana'];                 // default seeded players
const hasName = (obj) => NAMES.some((n) => JSON.stringify(obj).includes(n));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}  -  ${detail}`);
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
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

async function startBackend(dbPath) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, REMINDER_CHECK_MS: '1000',
      MQTT_CLIENT_ID: `petlink_test_backend_${process.pid}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  if (!(await waitFor(() => log.includes('Subscribed to topics'), 15000))) {
    child.kill();
    throw new Error(`Backend did not connect to the broker at ${BROKER}.\n--- backend log ---\n${log}`);
  }
  return child;
}

async function main() {
  console.log(`\nPetLink reminder tests  (broker ${BROKER})\n`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-rem-'));
  const backend = await startBackend(path.join(tmpDir, 'test.db'));

  // Fake station: says it's online, listens for commands
  const cmds = [];
  const station = mqtt.connect(BROKER, { clientId: `${DEVICE}_${process.pid}`, reconnectPeriod: 0 });
  await new Promise((res, rej) => { station.on('connect', res); station.on('error', rej); });
  station.publish(STATUS_TOPIC, JSON.stringify({ deviceId: DEVICE, online: true, ip: '10.0.0.42', pending: 0 }), { qos: 1, retain: true });
  await sleep(300);
  HABIT_IDS.forEach((h) => station.publish(`${CMD_TOPIC}/reminder/${h}`, '', { retain: true }));   // clear old runs
  await sleep(300);
  await new Promise((res) => station.subscribe(`${CMD_TOPIC}/#`, { qos: 1 }, res));
  station.on('message', (t, buf) => {
    if (!t.startsWith(CMD_TOPIC)) return;
    const habit = t.split('/').pop();
    cmds.push(buf.length ? { ...JSON.parse(buf), topic: t, at: Date.now() }
                         : { type: 'cleared', habit_id: habit, topic: t, at: Date.now() });
  });

  try {
    // 1. Defaults exist and are readable through the API
    const list = (await request('GET', '/api/reminders')).body.data;
    record('Default reminders are stored', list.length >= 3,
      `${list.length} reminders: ${list.map((r) => `${r.time} ${r.habitId}`).join(', ')}`);

    // 2. Bad input is rejected
    const bad1 = await request('POST', '/api/reminders', { habitId: 'water', time: '25:00', text: 'x' });
    const bad2 = await request('POST', '/api/reminders', { habitId: 'nope', time: '10:00', text: 'x' });
    const bad3 = await request('POST', '/api/reminders', { habitId: 'water', time: '10:00', text: '' });
    record('Invalid reminders are rejected', [bad1, bad2, bad3].every((r) => r.status === 400),
      `status codes ${bad1.status}/${bad2.status}/${bad3.status} (expected 400s): "${bad1.body.error}"`);

    // 3. "Send now" reaches the station in the plan's command format
    const water = list.find((r) => r.habitId === 'water');
    const t0 = Date.now();
    await request('POST', `/api/reminders/${water.id}/send`);
    const c = await waitFor(() => cmds.find((x) => x.type === 'reminder' && x.habit_id === 'water'));
    const okFormat = c && c.text && c.id && typeof c.buzz === 'boolean' && c.expires > c.ts && c.remaining === 4;
    record('Manual reminder reaches the station', !!okFormat,
      c ? `${c.at - t0} ms, ${JSON.stringify({ type: c.type, habit_id: c.habit_id, text: c.text, remaining: c.remaining, buzz: c.buzz })}` : 'nothing received');

    // 4. Scheduler fires at the set time, exactly once
    let now = new Date();
    if (now.getSeconds() > 50) { await sleep((61 - now.getSeconds()) * 1000); now = new Date(); }
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const created = (await request('POST', '/api/reminders', { habitId: 'reading', time: hhmm, text: 'Read now!' })).body.data;
    const sched = await waitFor(() => cmds.find((x) => x.text === 'Read now!'), 5000);
    await sleep(3000);
    const count = cmds.filter((x) => x.text === 'Read now!').length;
    record('Scheduled reminder fires once at its time', !!sched && count === 1,
      `set for ${hhmm}, received ${count} time(s)`);

    // 5. Count goes down as players log the habit, cleared when everyone is done
    const counts = [];
    for (const uid of UIDS) {
      const n = cmds.length;
      await request('POST', '/api/habits/log', { uid, habit: 'water' });
      const u = await waitFor(() => cmds.slice(n).find((x) => x.habit_id === 'water' && x.type !== 'reminder'), 3000);
      counts.push(u ? (u.type === 'cleared' ? 'clear' : u.remaining) : 'none');
    }
    record('Count updates as players finish, then clears', counts.join(',') === '3,2,1,clear',
      `after each of 4 players logs water: ${counts.join(' -> ')}`);

    // 6. Personal to-do list only after a card tap (sent with the station display)
    const display = [];
    const disp = mqtt.connect(BROKER, { clientId: `${DEVICE}_disp_${process.pid}`, reconnectPeriod: 0 });
    await new Promise((res) => disp.on('connect', res));
    await new Promise((res) => disp.subscribe('petlink/device/display', res));
    disp.on('message', (t, buf) => display.push(JSON.parse(buf)));
    station.publish('petlink/device/rfid', JSON.stringify({ uid: UIDS[0], deviceId: DEVICE }));
    const ready = await waitFor(() => display.find((d) => d.status === 'ready'), 3000);
    disp.end(true);
    const allCmdsAnonymous = cmds.every((x) => !hasName(x));
    record('Privacy: names never in reminders, to-do only after card tap',
      allCmdsAnonymous && !!ready && ready.todo && !ready.todo.includes('Water'),
      `${cmds.length} commands checked, none contain a name; Alex's card tap shows to-do: "${ready ? ready.todo : 'none'}"`);

    // 7. Skipped when everyone already did the habit
    const before = cmds.length;
    const skip = (await request('POST', `/api/reminders/${water.id}/send`)).body.data;
    await sleep(1000);
    record('Skipped when everyone already did it', skip.sent === false && skip.skipped === 'everyone_done' && cmds.length === before,
      `result: ${JSON.stringify({ sent: skip.sent, skipped: skip.skipped })}, nothing published`);

    // 8. Retained: a station that connects later gets every still-active reminder
    //    (reading is active; water was cleared because everyone did it)
    const late = mqtt.connect(BROKER, { clientId: `${DEVICE}_late_${process.pid}`, reconnectPeriod: 0 });
    const retained = {};
    late.on('message', (t, buf) => { if (buf.length) retained[t.split('/').pop()] = JSON.parse(buf); });
    await new Promise((res) => late.on('connect', res));
    late.subscribe(`${CMD_TOPIC}/#`, { qos: 1 });
    await sleep(1500);
    late.end(true);
    record('Offline station gets active reminders on reconnect',
      !!retained.reading && retained.reading.text === 'Read now!' && !retained.water,
      `retained on reconnect: ${Object.keys(retained).map((h) => `${h} "${retained[h].text}"`).join(', ') || 'none'}; water not resent (cleared)`);

    // 9. Edit and delete through the API
    const upd = await request('PATCH', `/api/reminders/${created.id}`, { time: '07:45', enabled: false });
    const badUpd = await request('PATCH', `/api/reminders/${created.id}`, { time: '7:45pm' });
    const del = await request('DELETE', `/api/reminders/${created.id}`);
    const delAgain = await request('DELETE', `/api/reminders/${created.id}`);
    record('Reminder times can be changed without re-flashing',
      upd.status === 200 && upd.body.data.time === '07:45' && !upd.body.data.enabled && badUpd.status === 400 && del.status === 200 && delAgain.status === 404,
      `PATCH -> ${upd.body.data && upd.body.data.time} (disabled), bad PATCH ${badUpd.status}, DELETE ${del.status} then ${delAgain.status}`);
  } finally {
    HABIT_IDS.forEach((h) => station.publish(`${CMD_TOPIC}/reminder/${h}`, '', { retain: true }));   // clean up
    station.publish(STATUS_TOPIC, '', { retain: true });
    await sleep(300);
    station.end(true);
    backend.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `reminders-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  fs.writeFileSync(file, ['test,result,detail', ...results.map((r) =>
    `"${r.name}",${r.pass ? 'PASS' : 'FAIL'},"${r.detail.replace(/"/g, "'")}"`)].join('\n') + '\n');

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed. Results saved to ${path.relative(process.cwd(), file)}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest run failed:', err.message);
  process.exit(1);
});
