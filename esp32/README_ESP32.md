# PetLink ESP32 Station — Wiring & Hardware Guide

This folder contains the complete firmware for the **PetLink IoT Hardware Station** powered by an **ESP32 DevKit V1**.

---

## 1. Complete Pinout & Wiring Table

All four modules connect to the ESP32 DevKit V1 as shown below:

### A. I2C Bus (Shared by SSD1306 OLED & BH1750 Light Sensor)
The OLED and BH1750 share the exact same I2C lines:
| Module Pin | ESP32 GPIO | Notes |
| :--- | :--- | :--- |
| **VCC** (OLED & BH1750) | **3V3** or **5V** | 3.3V recommended |
| **GND** (OLED & BH1750) | **GND** | Common Ground |
| **SDA** (OLED & BH1750) | **GPIO 21** | I2C Data |
| **SCL** (OLED & BH1750) | **GPIO 22** | I2C Clock |

*Tip: You can use a small breadboard power/rail or wire splice to share GPIO 21 and GPIO 22.*

---

### B. RC522 RFID Reader (SPI Bus)
| RC522 Pin | ESP32 GPIO | Description |
| :--- | :--- | :--- |
| **VCC / 3.3V** | **3V3** | **IMPORTANT: Connect to 3.3V ONLY** (5V damages RC522) |
| **RST** | **GPIO 4** | Reset pin |
| **GND** | **GND** | Ground |
| **MISO / SO** | **GPIO 19** | SPI Master In Slave Out |
| **MOSI / SI** | **GPIO 23** | SPI Master Out Slave In |
| **SCK** | **GPIO 18** | SPI Clock |
| **SS / SDA** | **GPIO 5** | SPI Slave Select / Chip Select |

---

### C. Three Push Buttons (Active LOW with Internal Pull-Ups)
No external resistors needed! The firmware activates `INPUT_PULLUP` on all three buttons.
| Button | One Pin Connected To | Other Pin Connected To |
| :--- | :--- | :--- |
| **NEXT** | **GPIO 25** | **GND** |
| **SELECT** | **GPIO 26** | **GND** |
| **CONFIRM** | **GPIO 27** | **GND** |

---

## 2. Arduino IDE Setup & Required Libraries

1. In Arduino IDE, open **Tools > Manage Libraries...** (or press `Ctrl + Shift + I`).
2. Search and install the following official libraries:
   - **`PubSubClient`** by Nick O'Leary (for MQTT)
   - **`ArduinoJson`** by Benoît Blanchon (v6 or v7)
   - **`Adafruit SSD1306`** by Adafruit
   - **`Adafruit GFX Library`** by Adafruit
   - **`MFRC522`** by GithubCommunity / keypad
   - **`BH1750`** by Christopher Laws

---

## 3. Configuration & Flashing

1. Open `esp32/config.h` in Arduino IDE or a text editor.
2. Update your phone's mobile hotspot details:
   ```cpp
   const char* WIFI_SSID     = "Your_Phone_Hotspot_Name";
   const char* WIFI_PASSWORD = "Your_Hotspot_Password";
   ```
3. Find your Windows laptop's IP address on the mobile hotspot network:
   - Open PowerShell or Command Prompt on your laptop.
   - Run: `ipconfig`
   - Look for **Wireless LAN adapter Wi-Fi** -> **IPv4 Address** (e.g., `192.168.43.150`).
   - Enter that IP in `config.h`:
   ```cpp
   const char* MQTT_BROKER   = "192.168.43.150"; // Your laptop IP
   ```
4. Connect ESP32 via micro-USB.
5. In Arduino IDE:
   - Select Board: **DOIT ESP32 DEVKIT V1** (or ESP32 Dev Module).
   - Select your COM Port.
   - Click **Upload**.
6. Open **Serial Monitor** at **115200 baud** to watch live debug logs.

---

## 4. Hardware Operation Flow

1. **Boot**: The OLED will show "PETLINK STATION" and "Connecting WiFi...". Once connected, it displays "Scan RFID Card".
2. **Scan Card**: Tap an RFID card onto the RC522. The ESP32 sends the UID over MQTT. The backend identifies the player and sends pet info back to the screen.
3. **Cycle Habit**: Press the **NEXT** button (GPIO 25) to cycle between:
   - `Drink Water` (+15 XP, +10 HP)
   - `Daily Workout` (+35 XP, +20 HP)
   - `Read Book` (+25 XP, +15 HP)
4. **Confirm Habit**: Press the **CONFIRM** button (GPIO 27). The ESP32 publishes the choice to `petlink/device/habit`.
5. **Result**: 
   - If first time today: Awards XP & Happiness, shows "+XP / +HP" and Level on OLED, and plays animation on the website.
   - If already done today: OLED shows "ALREADY LOGGED! Try another habit".
6. **Day/Night Ambient**: Cover or shine light on the BH1750 sensor:
   - `>= 50 lux`: Shared habitat becomes **DAY** (Sun & bright sky).
   - `< 50 lux`: Shared habitat becomes **NIGHT** (Moon & starry sky).
