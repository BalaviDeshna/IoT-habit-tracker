/**
 * =========================================================================
 * PetLink - ESP32 Hardware Station Firmware
 * =========================================================================
 * Hardware:
 *   - ESP32 DevKit V1
 *   - SSD1306 0.96" I2C OLED (SDA 21, SCL 22)
 *   - BH1750 Ambient Light Sensor (Shared I2C SDA 21, SCL 22)
 *   - RC522 RFID Reader (SS 5, RST 4, SCK 18, MOSI 23, MISO 19)
 *   - Push Buttons: NEXT (25), SELECT (26), CONFIRM (27)
 *
 * Store-and-forward (offline mode):
 *   - Confirmed habits are saved to flash first (offline_queue.*), then sent.
 *   - Each event has a unique eventId; it is deleted from flash only after the
 *     backend replies on petlink/device/ack. Retries are therefore safe.
 *   - Wi-Fi/MQTT reconnect is non-blocking, so the station keeps working
 *     (RFID + buttons + OLED) while offline and syncs when back online.
 *   - Online/offline status is published (retained) with an MQTT Last Will.
 *   - Events carry a real timestamp from NTP when available.
 * =========================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <BH1750.h>
#include <ArduinoJson.h>
#include <time.h>

#include "config.h"
#include "offline_queue.h"

// OLED Display Configuration
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
BH1750 lightMeter;
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Habits list matching backend
const int NUM_HABITS = 3;
const char* HABIT_KEYS[NUM_HABITS]  = { "water", "exercise", "reading" };
const char* HABIT_NAMES[NUM_HABITS] = { "Drink Water", "Daily Workout", "Read Book" };
const char* HABIT_ICONS[NUM_HABITS] = { "[H2O]", "[RUN]", "[BOOK]" };

// State Machine
enum StationState {
  STATE_IDLE,
  STATE_HABIT_SELECT,
  STATE_CONFIRMING,
  STATE_SHOW_MESSAGE
};

StationState currentState = STATE_IDLE;
String activeUid = "";
String activePlayerName = "";
int selectedHabitIndex = 0;

// Button debounce timers
unsigned long lastBtnNextPress = 0;
unsigned long lastBtnSelectPress = 0;
unsigned long lastBtnConfirmPress = 0;
const unsigned long DEBOUNCE_DELAY = 250; // ms

// Light sensor timer
unsigned long lastLuxSendTime = 0;
unsigned long stateTimeout = 0;

// Store-and-forward state
String inflightEventId = "";          // event sent, waiting for backend ACK
unsigned long inflightSentAt = 0;
int syncedThisSession = 0;            // events delivered from the offline queue
unsigned long messageUntil = 0;       // STATE_SHOW_MESSAGE ends at this time
String statusTopic;                   // petlink/device/status/<MQTT_CLIENT_ID>
char willPayload[160];                // Last Will message ("offline")
bool timeSynced = false;

// Display lines buffer
String dispLine1 = "PETLINK STATION";
String dispLine2 = "Starting up...";
String dispLine3 = "Connecting WiFi";
String dispLine4 = "";

// Forward declarations
void setupWiFi();
void reconnectMQTT();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void updateOled();
void renderHabitSelection();
void renderScreen(const String& l1, const String& l2, const String& l3, const String& l4);
void handleRfidCard();
void handleButtons();
void readAndPublishLight();
void maintainWiFi();
void flushQueue();
void handleAck(const char* json);
void showIdle();
void showMessage(const String& l1, const String& l2, const String& l3, const String& l4, unsigned long ms);
bool isOnline();

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[PetLink] Booting ESP32 Station...");

  // 1. Initialize Buttons
  pinMode(BTN_NEXT_PIN, INPUT_PULLUP);
  pinMode(BTN_SELECT_PIN, INPUT_PULLUP);
  pinMode(BTN_CONFIRM_PIN, INPUT_PULLUP);

  // 2. Initialize I2C Bus (SDA = 21, SCL = 22)
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  // 3. Initialize OLED Display
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println("[ERROR] SSD1306 allocation failed! Check wiring on SDA 21, SCL 22.");
  } else {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    renderScreen("PETLINK STATION", "DevKit V1 Ready", "Initializing...", "");
    Serial.println("[PetLink] OLED Display initialized.");
  }

  // 4. Initialize BH1750 Light Sensor
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    Serial.println("[PetLink] BH1750 Light Sensor initialized.");
  } else {
    Serial.println("[WARN] BH1750 initialization failed! Will retry later.");
  }

  // 5. Initialize SPI & RC522 RFID Reader
  SPI.begin(RFID_SCK_PIN, RFID_MISO_PIN, RFID_MOSI_PIN, RFID_SS_PIN);
  rfid.PCD_Init();
  delay(50);
  rfid.PCD_DumpVersionToSerial();
  Serial.println("[PetLink] RC522 RFID Reader initialized.");

  // 6. Offline queue in flash (store-and-forward)
  OfflineQueue::begin(MQTT_CLIENT_ID);

  // 7. Connect to WiFi & setup MQTT
  statusTopic = String(TOPIC_STATUS_PREFIX) + MQTT_CLIENT_ID;
  snprintf(willPayload, sizeof(willPayload),
           "{\"deviceId\":\"%s\",\"online\":false,\"reason\":\"connection_lost\"}", MQTT_CLIENT_ID);

  setupWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);   // default 256 B is too small for event JSON
  mqttClient.setKeepAlive(10);     // broker notices a dead station within ~15 s

  showIdle();
  Serial.println("[PetLink] Setup complete. Ready for players!");
}

void loop() {
  // 1. Maintain WiFi & MQTT connection (non-blocking: station stays usable offline)
  maintainWiFi();
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  // 1b. Deliver events saved in flash, one at a time, oldest first
  flushQueue();

  // 1c. A submitted habit got no reply -> it is safe in flash, tell the player
  if (currentState == STATE_CONFIRMING && inflightEventId.length() > 0 &&
      millis() - inflightSentAt > ACK_TIMEOUT_MS) {
    showMessage("SAVED ON DEVICE", "No reply from hub", "Will sync later", String(OfflineQueue::pending()) + " pending", 3000);
  }

  // 1d. Temporary messages return to the idle screen
  if (currentState == STATE_SHOW_MESSAGE && millis() > messageUntil) {
    currentState = STATE_IDLE;
    activeUid = "";
    showIdle();
  }

  // 2. Read Light Sensor periodically
  if (millis() - lastLuxSendTime >= LUX_READ_INTERVAL_MS) {
    readAndPublishLight();
    lastLuxSendTime = millis();
  }

  // 3. Handle RFID Card Reader
  handleRfidCard();

  // 4. Handle Physical Buttons
  handleButtons();

  // 5. Inactivity timeout (returns to idle after 30s)
  if (currentState == STATE_HABIT_SELECT && millis() > stateTimeout) {
    Serial.println("[PetLink] Habit selection timed out. Returning to IDLE.");
    currentState = STATE_IDLE;
    activeUid = "";
    renderScreen("PETLINK STATION", "Session Timed Out", "Scan RFID Card", "Ready...");
  }
}

// =========================================================================
// Wi-Fi & MQTT Management
// =========================================================================
// Boot-time connect: waits up to ~8 s, then continues in offline mode.
void setupWiFi() {
  Serial.printf("\n[WiFi] Connecting to %s", WIFI_SSID);
  renderScreen("WIFI CONNECTING", WIFI_SSID, "Please wait...", "");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 16) {
    delay(500);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP address: %s\n", WiFi.localIP().toString().c_str());
    renderScreen("WIFI CONNECTED!", WiFi.localIP().toString(), "Connecting MQTT", "");
  } else {
    Serial.println("\n[WiFi] Connection failed. Starting in OFFLINE mode, will keep retrying.");
    renderScreen("WIFI FAILED!", "Offline mode on", "Habits are saved", "Retrying...");
    delay(1500);
  }
}

// Called every loop. Never blocks: just notices changes and re-tries every WIFI_RETRY_MS.
void maintainWiFi() {
  static bool wasConnected = false;
  static unsigned long lastAttempt = 0;
  bool connected = (WiFi.status() == WL_CONNECTED);

  if (connected && !wasConnected) {
    Serial.printf("[WiFi] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
    configTime(TZ_OFFSET_SEC, 0, NTP_SERVER);   // start NTP time sync in background
  }
  if (!connected && wasConnected) {
    Serial.println("[WiFi] Lost connection -> OFFLINE mode (habits saved to flash).");
    if (currentState == STATE_IDLE) showIdle();
  }
  wasConnected = connected;

  if (!connected && millis() - lastAttempt > WIFI_RETRY_MS) {
    lastAttempt = millis();
    Serial.println("[WiFi] Retrying...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  // Note when NTP time becomes valid (any time after 2023 means synced)
  if (!timeSynced && time(nullptr) > 1700000000) {
    timeSynced = true;
    Serial.println("[Time] NTP time synced.");
  }
}

bool isOnline() {
  return WiFi.status() == WL_CONNECTED && mqttClient.connected();
}

void reconnectMQTT() {
  static unsigned long lastMqttAttempt = 0;
  if (millis() - lastMqttAttempt < MQTT_RETRY_MS) return;
  lastMqttAttempt = millis();

  if (WiFi.status() != WL_CONNECTED) return;

  Serial.printf("[MQTT] Connecting to broker %s:%d...\n", MQTT_BROKER, MQTT_PORT);
  // Last Will: if this station disappears (power cut, Wi-Fi gone) the BROKER
  // publishes willPayload for us, retained, so everyone learns we're offline.
  if (mqttClient.connect(MQTT_CLIENT_ID, statusTopic.c_str(), 1, true, willPayload)) {
    Serial.println("[MQTT] Connected successfully!");
    mqttClient.subscribe(TOPIC_DISPLAY);
    mqttClient.subscribe(TOPIC_ACK);
    Serial.printf("[MQTT] Subscribed to: %s, %s\n", TOPIC_DISPLAY, TOPIC_ACK);

    // Retained "online" status (replaces the Last Will message on the broker)
    JsonDocument doc;
    doc["deviceId"] = MQTT_CLIENT_ID;
    doc["online"] = true;
    doc["ip"] = WiFi.localIP().toString();
    doc["pending"] = OfflineQueue::pending();
    char out[200];
    serializeJson(doc, out);
    mqttClient.publish(statusTopic.c_str(), out, true);

    inflightEventId = "";              // re-send anything unacknowledged
    if (currentState == STATE_IDLE) showIdle();
    if (OfflineQueue::pending() > 0) {
      Serial.printf("[Sync] Back online with %d saved event(s). Syncing...\n", OfflineQueue::pending());
    }
  } else {
    Serial.printf("[MQTT] Connect failed, rc=%d. Retrying in %ds...\n", mqttClient.state(), MQTT_RETRY_MS / 1000);
  }
}

// Send the oldest saved event if nothing is waiting for an ACK.
void flushQueue() {
  if (!isOnline() || OfflineQueue::pending() == 0) return;
  if (inflightEventId.length() > 0 && millis() - inflightSentAt < ACK_TIMEOUT_MS) return;

  String eventId, json;
  if (!OfflineQueue::peekOldest(eventId, json)) return;

  JsonDocument doc;
  if (deserializeJson(doc, json)) {                 // corrupted file -> drop it
    Serial.printf("[Sync] Dropping corrupted event %s\n", eventId.c_str());
    OfflineQueue::remove(eventId);
    return;
  }
  doc["replayed"] = true;                           // tells backend: from the queue
  char out[384];
  serializeJson(doc, out);

  if (mqttClient.publish(TOPIC_HABIT, out)) {
    inflightEventId = eventId;
    inflightSentAt = millis();
    Serial.printf("[Sync] Sent %s (%d pending)\n", eventId.c_str(), OfflineQueue::pending());
  }
}

// Backend says "stored event X" -> delete it from flash.
void handleAck(const char* json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  const char* dev = doc["deviceId"] | "";
  const char* eventId = doc["eventId"] | "";
  if (strcmp(dev, MQTT_CLIENT_ID) != 0 || strlen(eventId) == 0) return;

  bool wasReplay = (inflightEventId == eventId) && currentState != STATE_CONFIRMING;
  if (OfflineQueue::remove(String(eventId)) && wasReplay) syncedThisSession++;
  if (inflightEventId == eventId) inflightEventId = "";

  // Whole backlog delivered -> say so on the OLED (only if nobody is using it)
  if (OfflineQueue::pending() == 0 && syncedThisSession > 0 && currentState == STATE_IDLE) {
    showMessage("SYNC COMPLETE", String(syncedThisSession) + " saved habit(s)", "sent to the hub", "", 3000);
    syncedThisSession = 0;
  }
}

// =========================================================================
// Incoming MQTT Callback (OLED Display Updates from Backend)
// =========================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char jsonBuffer[512];
  if (length >= sizeof(jsonBuffer)) length = sizeof(jsonBuffer) - 1;
  memcpy(jsonBuffer, payload, length);
  jsonBuffer[length] = '\0';

  Serial.printf("[MQTT RX] [%s] %s\n", topic, jsonBuffer);

  // ACKs for store-and-forward events
  if (strcmp(topic, TOPIC_ACK) == 0) {
    handleAck(jsonBuffer);
    return;
  }

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, jsonBuffer);
  if (error) {
    Serial.printf("[JSON] Deserialization error: %s\n", error.c_str());
    return;
  }

  const char* line1 = doc["line1"] | "";
  const char* line2 = doc["line2"] | "";
  const char* line3 = doc["line3"] | "";
  const char* line4 = doc["line4"] | "";
  const char* status = doc["status"] | "";

  if (strcmp(status, "ready") == 0) {
    currentState = STATE_HABIT_SELECT;
    stateTimeout = millis() + 30000; // 30 sec timeout
    selectedHabitIndex = 0;
    renderHabitSelection();
  } else if (strcmp(status, "idle") == 0 && currentState == STATE_HABIT_SELECT) {
    // don't wipe out a player who is still choosing a habit
    return;
  } else {
    renderScreen(line1, line2, line3, line4);
    // Result of a submitted habit -> show it for 5 s, then back to idle
    if (currentState == STATE_CONFIRMING) {
      currentState = STATE_SHOW_MESSAGE;
      messageUntil = millis() + 5000;
    } else if (strcmp(status, "idle") == 0) {
      currentState = STATE_IDLE;
    }
  }
}

// =========================================================================
// RFID Card Detection
// =========================================================================
void handleRfidCard() {
  // Look for new cards
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  // Extract UID as Hex string
  String uidStr = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uidStr += "0";
    uidStr += String(rfid.uid.uidByte[i], HEX);
  }
  uidStr.toUpperCase();

  Serial.printf("[RFID] Card Detected! UID: %s\n", uidStr.c_str());
  activeUid = uidStr;
  currentState = STATE_HABIT_SELECT;
  selectedHabitIndex = 0;
  stateTimeout = millis() + 30000;

  // Publish to backend
  StaticJsonDocument<256> doc;
  doc["uid"] = activeUid;
  doc["deviceId"] = MQTT_CLIENT_ID;
  doc["timestamp"] = millis();

  char outBuffer[256];
  serializeJson(doc, outBuffer);

  if (isOnline()) {
    mqttClient.publish(TOPIC_RFID, outBuffer);
    Serial.printf("[MQTT TX] [%s] %s\n", TOPIC_RFID, outBuffer);
    // Show immediate feedback on OLED
    renderScreen("CARD SCANNED!", "UID: " + uidStr, "Loading profile...", "Please wait...");
  } else {
    // Offline: the hub can't look the card up, so let the player pick a habit
    // locally. The habit is saved in flash and checked by the hub on sync.
    Serial.println("[RFID] Offline -> local habit selection.");
    renderScreen("OFFLINE MODE", "Card: " + uidStr, "Habit will be saved", "and synced later");
    delay(1200);
    renderHabitSelection();
  }

  // Halt PICC to avoid re-triggering immediately
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// =========================================================================
// Physical Push Buttons Navigation
// =========================================================================
void handleButtons() {
  unsigned long now = millis();

  // NEXT Button (GPIO 25) - Cycle to next habit
  if (digitalRead(BTN_NEXT_PIN) == LOW && (now - lastBtnNextPress > DEBOUNCE_DELAY)) {
    lastBtnNextPress = now;
    Serial.println("[Button] NEXT pressed.");

    if (currentState == STATE_HABIT_SELECT) {
      selectedHabitIndex = (selectedHabitIndex + 1) % NUM_HABITS;
      stateTimeout = now + 30000;
      renderHabitSelection();
    } else {
      Serial.println("[Button] NEXT ignored (no active card session).");
    }
  }

  // SELECT Button (GPIO 26) - Cycle or preview
  if (digitalRead(BTN_SELECT_PIN) == LOW && (now - lastBtnSelectPress > DEBOUNCE_DELAY)) {
    lastBtnSelectPress = now;
    Serial.println("[Button] SELECT pressed.");

    if (currentState == STATE_HABIT_SELECT) {
      selectedHabitIndex = (selectedHabitIndex + 1) % NUM_HABITS;
      stateTimeout = now + 30000;
      renderHabitSelection();
    }
  }

  // CONFIRM Button (GPIO 27) - Submit chosen habit to backend!
  if (digitalRead(BTN_CONFIRM_PIN) == LOW && (now - lastBtnConfirmPress > DEBOUNCE_DELAY)) {
    lastBtnConfirmPress = now;
    Serial.println("[Button] CONFIRM pressed.");

    if (currentState == STATE_HABIT_SELECT && activeUid.length() > 0) {
      const char* chosenHabit = HABIT_KEYS[selectedHabitIndex];
      Serial.printf("[PetLink] Confirming habit: %s for UID: %s\n", chosenHabit, activeUid.c_str());

      // Build the habit event with a unique id and a real timestamp
      String eventId = OfflineQueue::nextEventId();
      time_t nowEpoch = time(nullptr);
      bool haveTime = nowEpoch > 1700000000;

      JsonDocument doc;
      doc["eventId"] = eventId;
      doc["uid"] = activeUid;
      doc["habit"] = chosenHabit;
      doc["deviceId"] = MQTT_CLIENT_ID;
      doc["ts"] = haveTime ? (long long)nowEpoch : 0;   // unix seconds (UTC)
      doc["tsSource"] = haveTime ? "ntp" : "none";
      doc["timestamp"] = millis();
      doc["replayed"] = false;

      char outBuffer[384];
      serializeJson(doc, outBuffer);

      // 1) Write-ahead: save to flash FIRST, so a failed send can't lose it
      bool saved = OfflineQueue::push(eventId, String(outBuffer));
      if (!saved) {
        Serial.println("[Queue] Could not save event! Sending without backup.");
      }

      // 2) Try to send now; it stays in flash until the backend ACKs it
      if (isOnline() && mqttClient.publish(TOPIC_HABIT, outBuffer)) {
        Serial.printf("[MQTT TX] [%s] %s\n", TOPIC_HABIT, outBuffer);
        if (saved) {
          inflightEventId = eventId;
          inflightSentAt = millis();
        }
        renderScreen("SUBMITTING...", HABIT_NAMES[selectedHabitIndex], "Checking daily log", "Please wait...");
        currentState = STATE_CONFIRMING;
      } else if (saved) {
        Serial.printf("[Queue] Offline: %s stored for later sync.\n", eventId.c_str());
        showMessage("SAVED OFFLINE", HABIT_NAMES[selectedHabitIndex],
                    String(OfflineQueue::pending()) + " waiting to sync", "Syncs when online", 3000);
      } else {
        showMessage("NOT SAVED!", "Device storage full", "Connect to hub", "and try again", 3000);
      }
    } else {
      renderScreen("NO CARD ACTIVE!", "Scan RFID Card", "first to select", "a habit.");
      delay(1500);
      renderScreen("PETLINK STATION", "Ready", "Scan RFID Card", ">> Tap Here <<");
    }
  }
}

// =========================================================================
// Light Sensor (BH1750)
// =========================================================================
void readAndPublishLight() {
  float lux = lightMeter.readLightLevel();
  if (lux < 0) {
    Serial.println("[WARN] BH1750 read error.");
    return;
  }

  Serial.printf("[BH1750] Light: %.1f lux\n", lux);

  StaticJsonDocument<256> doc;
  doc["lux"] = lux;
  doc["deviceId"] = MQTT_CLIENT_ID;
  doc["timestamp"] = millis();

  char outBuffer[256];
  serializeJson(doc, outBuffer);
  if (isOnline()) {
    mqttClient.publish(TOPIC_LIGHT, outBuffer);   // only the latest reading matters, so no queueing
  }
}

// =========================================================================
// OLED Screen Display Helpers
// =========================================================================
void renderScreen(const String& l1, const String& l2, const String& l3, const String& l4) {
  dispLine1 = l1;
  dispLine2 = l2;
  dispLine3 = l3;
  dispLine4 = l4;
  updateOled();
}

// Idle screen; line 4 shows the offline / sync state.
void showIdle() {
  int n = OfflineQueue::pending();
  String status;
  if (!isOnline()) status = n > 0 ? "OFFLINE: " + String(n) + " saved" : "OFFLINE mode";
  else if (n > 0)  status = "Syncing " + String(n) + "...";
  else             status = ">> Tap Here <<";
  renderScreen("PETLINK STATION", "Ready", "Scan RFID Card", status);
}

// Show a message for `ms` milliseconds, then the loop returns to idle.
void showMessage(const String& l1, const String& l2, const String& l3, const String& l4, unsigned long ms) {
  renderScreen(l1, l2, l3, l4);
  currentState = STATE_SHOW_MESSAGE;
  messageUntil = millis() + ms;
}

void renderHabitSelection() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Header
  display.setCursor(0, 0);
  display.print("SELECT HABIT (NEXT)");

  // Divider
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // Active habit line with arrow
  display.setCursor(0, 16);
  display.printf("> %s", HABIT_NAMES[selectedHabitIndex]);

  // Habit key / details
  display.setCursor(14, 28);
  display.printf("%s +XP/+HP", HABIT_ICONS[selectedHabitIndex]);

  // Instructions
  display.drawLine(0, 42, 127, 42, SSD1306_WHITE);
  display.setCursor(0, 46);
  display.print("[NEXT] Cycle habit");
  display.setCursor(0, 56);
  display.print("[CONFIRM] Submit!");

  display.display();
}

void updateOled() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Line 1 (Header with box or inverse banner)
  display.fillRect(0, 0, 128, 12, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
  display.setCursor(2, 2);
  display.print(dispLine1);

  display.setTextColor(SSD1306_WHITE);

  // Line 2
  display.setCursor(0, 18);
  display.print(dispLine2);

  // Line 3
  display.setCursor(0, 32);
  display.print(dispLine3);

  // Line 4
  display.setCursor(0, 48);
  display.print(dispLine4);

  display.display();
}
