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

#include "config.h"

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

  // 6. Connect to WiFi & setup MQTT
  setupWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  renderScreen("PETLINK STATION", "Ready!", "Scan RFID Card", ">> Tap Here <<");
  Serial.println("[PetLink] Setup complete. Ready for players!");
}

void loop() {
  // 1. Maintain WiFi & MQTT connection
  if (WiFi.status() != WL_CONNECTED) {
    setupWiFi();
  }
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

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
void setupWiFi() {
  Serial.printf("\n[WiFi] Connecting to %s", WIFI_SSID);
  renderScreen("WIFI CONNECTING", WIFI_SSID, "Please wait...", "");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 25) {
    delay(500);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP address: %s\n", WiFi.localIP().toString().c_str());
    renderScreen("WIFI CONNECTED!", WiFi.localIP().toString(), "Connecting MQTT", "");
  } else {
    Serial.println("\n[WiFi] Connection failed. Will retry in loop.");
    renderScreen("WIFI FAILED!", "Check Hotspot", "Retrying...", "");
  }
}

void reconnectMQTT() {
  static unsigned long lastMqttAttempt = 0;
  if (millis() - lastMqttAttempt < 3000) return;
  lastMqttAttempt = millis();

  if (WiFi.status() != WL_CONNECTED) return;

  Serial.printf("[MQTT] Connecting to broker %s:%d...\n", MQTT_BROKER, MQTT_PORT);
  if (mqttClient.connect(MQTT_CLIENT_ID)) {
    Serial.println("[MQTT] Connected successfully!");
    mqttClient.subscribe(TOPIC_DISPLAY);
    Serial.printf("[MQTT] Subscribed to: %s\n", TOPIC_DISPLAY);
  } else {
    Serial.printf("[MQTT] Connect failed, rc=%d. Retrying in 3s...\n", mqttClient.state());
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
  } else {
    renderScreen(line1, line2, line3, line4);
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
  mqttClient.publish(TOPIC_RFID, outBuffer);
  Serial.printf("[MQTT TX] [%s] %s\n", TOPIC_RFID, outBuffer);

  // Show immediate feedback on OLED
  renderScreen("CARD SCANNED!", "UID: " + uidStr, "Loading profile...", "Please wait...");

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

      renderScreen("SUBMITTING...", HABIT_NAMES[selectedHabitIndex], "Checking daily log", "Please wait...");

      // Publish habit event to MQTT
      StaticJsonDocument<256> doc;
      doc["uid"] = activeUid;
      doc["habit"] = chosenHabit;
      doc["deviceId"] = MQTT_CLIENT_ID;
      doc["timestamp"] = millis();

      char outBuffer[256];
      serializeJson(doc, outBuffer);
      mqttClient.publish(TOPIC_HABIT, outBuffer);
      Serial.printf("[MQTT TX] [%s] %s\n", TOPIC_HABIT, outBuffer);

      currentState = STATE_CONFIRMING;
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
  mqttClient.publish(TOPIC_LIGHT, outBuffer);
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
