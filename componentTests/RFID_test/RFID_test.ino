#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define NEXT_BUTTON 25
#define SELECT_BUTTON 26
#define CONFIRM_BUTTON 27

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  -1
);

int lastNext = HIGH;
int lastSelect = HIGH;
int lastConfirm = HIGH;

void setup() {
  Serial.begin(115200);

  pinMode(NEXT_BUTTON, INPUT_PULLUP);
  pinMode(SELECT_BUTTON, INPUT_PULLUP);
  pinMode(CONFIRM_BUTTON, INPUT_PULLUP);

  Wire.begin(21, 22);

  if (!display.begin(
    SSD1306_SWITCHCAPVCC,
    0x3C
  )) {
    Serial.println("OLED not found!");
    while (true);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 10);
  display.println("PETLINK");
  display.println();
  display.println("Button test ready!");
  display.display();
}

void loop() {
  int nextState = digitalRead(NEXT_BUTTON);
  int selectState = digitalRead(SELECT_BUTTON);
  int confirmState = digitalRead(CONFIRM_BUTTON);

  if (lastNext == HIGH && nextState == LOW) {
    showMessage("NEXT pressed");
  }

  if (lastSelect == HIGH && selectState == LOW) {
    showMessage("SELECT pressed");
  }

  if (lastConfirm == HIGH && confirmState == LOW) {
    showMessage("CONFIRM pressed");
  }

  lastNext = nextState;
  lastSelect = selectState;
  lastConfirm = confirmState;

  delay(30);
}

void showMessage(const char* message) {
  Serial.println(message);

  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 10);
  display.println("PETLINK");
  display.println();
  display.println(message);
  display.display();
}