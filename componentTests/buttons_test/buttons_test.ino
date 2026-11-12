#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <BH1750.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  -1
);

BH1750 lightMeter;

void setup() {
  Serial.begin(115200);

  Wire.begin(21, 22);

  if (!display.begin(
    SSD1306_SWITCHCAPVCC,
    0x3C
  )) {
    Serial.println("OLED not found!");
    while (true);
  }

  if (!lightMeter.begin(
    BH1750::CONTINUOUS_HIGH_RES_MODE
  )) {
    Serial.println("BH1750 not found!");
    while (true);
  }

  Serial.println("PETLINK LIGHT SENSOR READY");
}

void loop() {
  float lux = lightMeter.readLightLevel();

  Serial.print("Light intensity: ");
  Serial.print(lux);
  Serial.println(" lux");

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 5);
  display.println("PETLINK HABITAT");

  display.setCursor(0, 25);
  display.print("Light: ");
  display.print(lux);
  display.println(" lux");

  display.setCursor(0, 45);

  if (lux > 100) {
    display.println("Habitat: DAY");
  } else {
    display.println("Habitat: NIGHT");
  }

  display.display();

  delay(1000);
}