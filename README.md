# PetLink 🐾 — IoT Multiplayer Virtual Pet & Habit Tracker

PetLink is an IoT multiplayer virtual pet habitat and daily habit tracking station built for an ESP32 DevKit V1 and a modern Node.js web dashboard.

Players scan their physical RFID tags at the station, cycle through daily habits (such as Drinking Water, Exercising, or Reading) using physical push buttons, and confirm their achievements. A confirmed habit rewards the player's virtual pet with XP and happiness, leveling it up over time while preventing duplicate logs on the same day. In addition, an ambient light sensor (BH1750) synchronizes the shared habitat between DAY and NIGHT in real time across the OLED screen and the web application.

---

## 🏗️ System Architecture

- **Hardware Station**: ESP32 DevKit V1
  - **OLED Display**: 0.96-inch SSD1306 (I2C: SDA 21, SCL 22)
  - **RFID Reader**: RC522 (SPI: SS 5, RST 4, SCK 18, MOSI 23, MISO 19)
  - **Light Sensor**: BH1750 (Shared I2C: SDA 21, SCL 22)
  - **Push Buttons**: NEXT (GPIO 25), SELECT (GPIO 26), CONFIRM (GPIO 27)
- **Backend**: Node.js, Express, Socket.IO, MQTT.js, `better-sqlite3` (SQLite with WAL mode)
- **Frontend**: Responsive HTML5, CSS3 (virtual-pet game aesthetic with dynamic Day/Night sky and animations), and vanilla JavaScript.
- **Broker**: Mosquitto MQTT Broker on port 1883.

---

## 📁 Project Structure

```
petlink/
├── backend/
│   ├── routes/
│   │   └── api.js          # REST API & web simulation endpoints
│   ├── mqttService.js      # MQTT client, topic subscriptions & OLED dispatch
│   ├── petLogic.js         # XP, leveling, habit rules & duplicate checks
│   └── server.js           # Express + HTTP + Socket.IO server
├── database/
│   ├── db.js               # SQLite connection, schema migration & seed data
│   └── petlink.db          # Auto-generated SQLite database file
├── frontend/
│   ├── css/
│   │   └── style.css       # Virtual pet game styling & Day/Night themes
│   ├── js/
│   │   └── app.js          # Socket.IO client, animations & live mirror
│   └── index.html          # Web dashboard with live OLED mirror & controls
├── esp32/
│   ├── config.h            # Wi-Fi credentials, laptop IP & pin configuration
│   ├── petlink_esp32.ino   # Complete ESP32 Arduino firmware
│   └── README_ESP32.md     # Wiring pinout table & flashing guide
├── test-mqtt-sim.js        # Terminal hardware simulator for testing
├── package.json            # Node.js project configuration & scripts
├── .env.example            # Environment variables template
├── .env                    # Local configuration
└── README.md               # Main documentation
```

---

## ⚡ Quickstart Guide (Windows)

### 1. Prerequisites
- **Node.js**: v18+ (tested on Node v22)
- **Mosquitto MQTT Broker**: Installed and running on Windows.
  - To verify Mosquitto is running, open PowerShell and run:
    ```powershell
    Get-Service mosquitto
    ```
    If stopped, start it with: `Start-Service mosquitto`

### 2. Install Backend Dependencies
Open PowerShell in the `petlink` project directory:
```powershell
npm install
```

### 3. Configure `.env`
Ensure `.env` matches your broker settings (defaults work out-of-the-box for localhost):
```ini
PORT=3000
MQTT_BROKER_URL=mqtt://127.0.0.1:1883
MQTT_CLIENT_ID=petlink_backend_server
DB_PATH=database/petlink.db
```

### 4. Start the Application
```powershell
npm start
```
You will see:
```
========================================================
🐾 PetLink Backend Server is running!
🌐 Local Web Dashboard: http://localhost:3000
📡 Connected to MQTT Broker: mqtt://127.0.0.1:1883
💾 Database: SQLite (WAL mode)
========================================================
```

Open your browser and navigate to: **[http://localhost:3000](http://localhost:3000)**.

---

## 🧪 Testing Without Physical Hardware

You can test the complete system immediately in two ways:

### Option A: Interactive Web Simulator (Directly in Browser)
1. Open **`http://localhost:3000`**.
2. Under **Station Controls & Hardware Simulation**:
   - Click any player's card (e.g., **"💳 Tap Alex (A1B2C3D4)"**). Notice the live SSD1306 OLED mirror update instantly.
   - Click **"+XP Log"** next to a habit (e.g., Drink Water).
   - Try clicking it a second time to verify the **same-day duplicate prevention**.
   - Move the **Light Sensor slider** or click **"Toggle Day/Night"** to watch the background sky shift dynamically between Day and Night!

### Option B: Terminal MQTT Simulator
In a second terminal window, run:
```powershell
npm run simulate
```
This script acts as a virtual ESP32 device: it sends light readings, scans RFID cards, logs habits, triggers duplicate checks, and prints the OLED response screen directly in the console.

---

## 📡 MQTT Topic Specification

| Topic | Direction | Payload Example | Purpose |
| :--- | :--- | :--- | :--- |
| `petlink/habitat/light` | ESP32 ➔ Server | `{"lux": 180.5, "deviceId": "esp32-v1", "timestamp": 1731940000}` | Ambient light level from BH1750 (Day &ge; 50 lx, Night &lt; 50 lx) |
| `petlink/device/rfid` | ESP32 ➔ Server | `{"uid": "A1B2C3D4", "deviceId": "esp32-v1", "timestamp": 1731940000}` | Player card scanned at RC522 |
| `petlink/device/habit` | ESP32 ➔ Server | `{"uid": "A1B2C3D4", "habit": "water", "deviceId": "esp32-v1"}` | Habit confirmed via physical buttons |
| `petlink/device/display` | Server ➔ ESP32 | `{"line1": "Hi Alex!", "line2": "Pet: Sparky", "line3": "Select habit...", "line4": ""}` | 4-line text updates rendered onto SSD1306 OLED |

---

## 👥 Predefined Players & Virtual Pets

The SQLite database is automatically seeded on first launch with 4 players:
1. **Alex** (Placeholder UID: `A1B2C3D4`) — Pet: **Sparky** 🦊 (Fox Sprite)
2. **Bella** (Placeholder UID: `E5F6A7B8`) — Pet: **Mochi** 🐱 (Star Cat)
3. **Charlie** (Placeholder UID: `C9D0E1F2`) — Pet: **Rex** 🦖 (Mini Dino)
4. **Diana** (Placeholder UID: `3A4B5C6D`) — Pet: **Luna** 🦉 (Moon Owl)

### Replacing Placeholder UIDs With Your Real RFID Cards
You can easily map your real cards:
- **From Web UI**: Click the `UID: ... ✏️` badge on any player card in the dashboard, type your card's hex UID (e.g. read from Arduino Serial Monitor), and click **Save UID**.
- **Via API**: `PUT /api/players/:id/uid` with body `{"rfid_uid": "YOUR_CARD_HEX"}`.

---

## 🎮 Integrating the Physical ESP32 Station

See [`esp32/README_ESP32.md`](file:///esp32/README_ESP32.md) for full wiring schematics and library setup:
1. Connect ESP32 to your phone's mobile hotspot.
2. Find your laptop's IP address on the hotspot network using `ipconfig`.
3. Set `MQTT_BROKER = "YOUR_LAPTOP_IP"` in `esp32/config.h`.
4. Flash `esp32/petlink_esp32.ino` using the Arduino IDE.
5. Tap your cards and track your habits in real-time!
