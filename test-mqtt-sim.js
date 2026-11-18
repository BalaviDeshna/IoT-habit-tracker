/**
 * PetLink - Terminal MQTT Hardware Simulator
 * Simulates ESP32 sensors and OLED display without physical hardware!
 */
const mqtt = require('mqtt');

const BROKER = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
console.log(`[SIMULATOR] Connecting to broker: ${BROKER}...`);

const client = mqtt.connect(BROKER, {
  clientId: `petlink_esp32_simulator_${Math.floor(Math.random() * 1000)}`
});

const TOPIC_LIGHT = 'petlink/habitat/light';
const TOPIC_RFID = 'petlink/device/rfid';
const TOPIC_HABIT = 'petlink/device/habit';
const TOPIC_DISPLAY = 'petlink/device/display';

client.on('connect', () => {
  console.log('[SIMULATOR] Connected to MQTT broker!');
  
  // Listen for display messages sent back to ESP32
  client.subscribe(TOPIC_DISPLAY, () => {
    console.log(`[SIMULATOR] Subscribed to OLED display topic: ${TOPIC_DISPLAY}`);
    runDemoSequence();
  });
});

client.on('message', (topic, message) => {
  if (topic === TOPIC_DISPLAY) {
    try {
      const data = JSON.parse(message.toString());
      console.log('\n+------------------------------------+');
      console.log('|      ESP32 OLED SCREEN MIRROR      |');
      console.log('+------------------------------------+');
      console.log(`| Line 1: ${(data.line1 || '').padEnd(26)} |`);
      console.log(`| Line 2: ${(data.line2 || '').padEnd(26)} |`);
      console.log(`| Line 3: ${(data.line3 || '').padEnd(26)} |`);
      console.log(`| Line 4: ${(data.line4 || '').padEnd(26)} |`);
      console.log('+------------------------------------+\n');
    } catch (e) {
      console.log('[SIMULATOR] Raw display message:', message.toString());
    }
  }
});

function sendLight(lux) {
  const payload = {
    lux: lux,
    deviceId: 'sim-esp32-v1',
    timestamp: Date.now()
  };
  console.log(`[SIMULATOR] >> Publishing Light reading: ${lux} lux`);
  client.publish(TOPIC_LIGHT, JSON.stringify(payload));
}

function sendRfid(uid) {
  const payload = {
    uid: uid,
    deviceId: 'sim-esp32-v1',
    timestamp: Date.now()
  };
  console.log(`[SIMULATOR] >> Publishing RFID card tap: "${uid}"`);
  client.publish(TOPIC_RFID, JSON.stringify(payload));
}

function sendHabit(uid, habit) {
  const payload = {
    uid: uid,
    habit: habit,
    deviceId: 'sim-esp32-v1',
    timestamp: Date.now()
  };
  console.log(`[SIMULATOR] >> Publishing habit submission: "${habit}" for UID "${uid}"`);
  client.publish(TOPIC_HABIT, JSON.stringify(payload));
}

function runDemoSequence() {
  console.log('\n[SIMULATOR] Starting automated hardware test sequence in 2 seconds...');

  setTimeout(() => {
    // 1. Send Day light reading
    sendLight(220.5);
  }, 2000);

  setTimeout(() => {
    // 2. Scan Alex's card
    sendRfid('A1B2C3D4');
  }, 4000);

  setTimeout(() => {
    // 3. Complete Water habit for Alex
    sendHabit('A1B2C3D4', 'water');
  }, 6000);

  setTimeout(() => {
    // 4. Try duplicate habit for Alex (testing duplicate prevention)
    console.log('[SIMULATOR] Testing duplicate completion prevention...');
    sendHabit('A1B2C3D4', 'water');
  }, 8000);

  setTimeout(() => {
    // 5. Scan Bella's card
    sendRfid('E5F6A7B8');
  }, 10000);

  setTimeout(() => {
    // 6. Complete Exercise habit for Bella
    sendHabit('E5F6A7B8', 'exercise');
  }, 12000);

  setTimeout(() => {
    // 7. Send Night light reading (below 50 lux threshold)
    sendLight(18.2);
  }, 14000);

  setTimeout(() => {
    console.log('[SIMULATOR] Demo test sequence completed! Simulator staying alive to mirror display.');
  }, 16000);
}
