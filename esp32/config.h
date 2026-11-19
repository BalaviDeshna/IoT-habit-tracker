#ifndef CONFIG_H
#define CONFIG_H

// =========================================================================
// PetLink ESP32 Configuration
// NOTE: Set your phone's mobile hotspot SSID & Password, and your laptop's IP!
// =========================================================================

// 1. Wi-Fi Settings (Connect ESP32 to phone hotspot)
const char* WIFI_SSID     = "meow";
const char* WIFI_PASSWORD = "meow";

// 2. MQTT Broker Settings (Your Windows Laptop running Mosquitto)
// Run `ipconfig` in Windows Command Prompt to find your laptop IPv4 address (e.g., 192.168.43.100)
const char* MQTT_BROKER   = "meow";
const int   MQTT_PORT     = 1883;
const char* MQTT_USERNAME = ""; // set if Mosquitto authentication is enabled
const char* MQTT_PASSWORD = "";
const char* MQTT_CLIENT_ID = "esp32_petlink_station";

// 3. MQTT Topics
const char* TOPIC_LIGHT   = "petlink/habitat/light";
const char* TOPIC_RFID    = "petlink/device/rfid";
const char* TOPIC_HABIT   = "petlink/device/habit";
const char* TOPIC_DISPLAY = "petlink/device/display";

// Store-and-forward / device reliability topics
// Status:  petlink/device/status/<MQTT_CLIENT_ID>  (retained, + Last Will "offline")
// Ack:     backend -> ESP32 "I stored event X, you can delete it from flash"
const char* TOPIC_STATUS_PREFIX = "petlink/device/status/";
const char* TOPIC_ACK     = "petlink/device/ack";

// Time (NTP) so events logged offline keep their real time. IST = UTC+5:30
#define NTP_SERVER        "pool.ntp.org"
#define TZ_OFFSET_SEC     19800

// Reliability timings
#define ACK_TIMEOUT_MS    5000   // re-send an event if no ACK within 5 s
#define WIFI_RETRY_MS     10000  // try to re-join Wi-Fi every 10 s (non-blocking)
#define MQTT_RETRY_MS     5000   // try to reconnect to the broker every 5 s

// Reminders from the hub arrive on  petlink/<MQTT_CLIENT_ID>/cmd
#define REMINDER_SHOW_MS  15000  // how long a reminder stays on the OLED
// Optional vibration motor / buzzer (driven through a transistor, never directly).
// -1 = not fitted (the OLED just flashes). Set e.g. 33 once the motor is wired.
#define BUZZ_PIN          -1

// 4. Pin Definitions (Matches user hardware exactly)
// I2C (SSD1306 OLED & BH1750 Light Sensor)
#define I2C_SDA_PIN    21
#define I2C_SCL_PIN    22

// RC522 RFID Reader (SPI)
#define RFID_SS_PIN     5
#define RFID_RST_PIN    4
#define RFID_SCK_PIN   18
#define RFID_MOSI_PIN  23
#define RFID_MISO_PIN  19

// Push Buttons (INPUT_PULLUP: active LOW)
#define BTN_NEXT_PIN   25
#define BTN_SELECT_PIN 26
#define BTN_CONFIRM_PIN 27

// 5. Light Sensor Thresholds
#define LUX_READ_INTERVAL_MS 5000 // Send light readings every 5 seconds

#endif // CONFIG_H
