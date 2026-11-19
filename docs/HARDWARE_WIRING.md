# PetLink hardware wiring (two ESP32 boards)

## Architecture and user association
- Hub ESP32 (`esp32/petlink_esp32.ino`): RC522 RFID + OLED + BH1750 + three buttons. A card scan identifies a family member. The backend assigns the demo wearable `band_01` to that player.
- Wearable ESP32 (`esp32/wearable/petlink_wearable.ino`): MPU6050 + BH1750 + OLED + two buttons. Publishes sensor/self-report events.
- Laptop: Mosquitto + Node backend + SQLite + website. Both ESP32 boards and browsers must be on the same Wi-Fi/hotspot.

**Important limitation:** with one wearable, RFID can switch the active player assigned to that band, but it cannot track two people simultaneously. For simultaneous tracking, use one wearable per person and assign each device ID separately. The current backend uses `DEFAULT_WEARABLE_ID=band_01`.

## Wearable ESP32 wiring
| Module pin | ESP32 |
|---|---|
| MPU6050 VCC/GND | 3V3/GND |
| MPU6050 SDA/SCL | GPIO21/GPIO22 |
| BH1750 VCC/GND | 3V3/GND |
| BH1750 SDA/SCL | GPIO21/GPIO22 |
| SSD1306 VCC/GND | 3V3/GND |
| SSD1306 SDA/SCL | GPIO21/GPIO22 |
| NEXT button | GPIO25 to GND |
| SELECT button | GPIO26 to GND |

I2C addresses expected: OLED 0x3C, BH1750 0x23, MPU6050 0x68. Verify with an I2C scanner if a module differs. The current initial firmware has no UV, battery, motor or reminders.

## Hub ESP32 wiring (existing sketch)
| Module pin | ESP32 |
|---|---|
| OLED VCC/GND | 3V3/GND |
| OLED SDA/SCL | GPIO21/GPIO22 |
| BH1750 VCC/GND | 3V3/GND |
| BH1750 SDA/SCL | GPIO21/GPIO22 |
| RC522 3.3V/GND | 3V3/GND (NEVER 5V)/GND |
| RC522 SDA/SS | GPIO5 |
| RC522 SCK | GPIO18 |
| RC522 MOSI | GPIO23 |
| RC522 MISO | GPIO19 |
| RC522 RST | GPIO4 |
| NEXT button | GPIO25 to GND |
| SELECT button | GPIO26 to GND |
| CONFIRM button | GPIO27 to GND |

Hub and wearable are separate ESP32s, so using the same GPIO numbers on both boards is fine. RC522 uses SPI and must be powered at 3.3V.

## Arduino libraries
Hub: PubSubClient, ArduinoJson, MFRC522, BH1750, Adafruit SSD1306, Adafruit GFX.
Wearable: PubSubClient, ArduinoJson, Adafruit MPU6050, Adafruit Unified Sensor, BH1750, Adafruit SSD1306, Adafruit GFX.

## MQTT contract
- Hub -> `petlink/device/rfid`: `{ "uid": "CARD_UID", "deviceId": "esp32_petlink_station" }`
- Wearable -> `petlink/band_01/event`: `{ device_id, event_id, habit_id, ts, ts_source, verified, daytime, data }`
- Wearable status -> `petlink/device/status/band_01` (retained)
- Backend ACK -> `petlink/device/ack`: `{ deviceId, eventId, outcome }`

The hub RFID scan binds the scanned player to `band_01`. Scan a different registered card to switch the wearable's active owner.

## Notes about multi-user operation
The existing database has multiple players, each identified by a unique RFID UID. When a known card is scanned at the hub, the backend sets the active owner of `band_01` to that player. This supports a demo where family members take turns using one wearable. It does **not** identify two simultaneous wearers. To support simultaneous users, provision a separate wearable per person (unique `DEVICE_ID`) and assign each ID to a player; the API/database assignment function is already device-ID based, but the current hub sketch's automatic assignment defaults to one configured ID.

## Broker security
The code accepts optional MQTT username/password values. Set `MQTT_USERNAME` and `MQTT_PASSWORD` in `.env`, and set matching `MQTT_USERNAME` / `MQTT_PASSWORD` constants in both ESP32 sketches. The sample Mosquitto config is development-only and allows anonymous connections; do not expose port 1883 to the public internet. Use a password file and topic ACLs for a secured demo.
