/* PetLink wearable firmware (ESP32 DevKit V1)
 * Sensors: MPU6050 + BH1750 + SSD1306; buttons NEXT/SELECT.
 * MQTT: petlink/<DEVICE_ID>/event and petlink/<DEVICE_ID>/status; ACK: petlink/device/ack.
 * The hub RFID station assigns DEVICE_ID to a player when their card is scanned.
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <BH1750.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <time.h>

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MQTT_HOST "192.168.1.100" // laptop IP running Mosquitto
#define MQTT_PORT 1883
#define MQTT_USERNAME ""
#define MQTT_PASSWORD ""
#define DEVICE_ID "band_01"
#define SDA_PIN 8        // Shared I2C data (MPU6050, BH1750, OLED) - ESP32-S3
#define SCL_PIN 9        // Shared I2C clock (MPU6050, BH1750, OLED) - ESP32-S3
#define NEXT_PIN 4       // Button 1 (to GND) - ESP32-S3
#define SELECT_PIN 5     // Button 2 (to GND) - ESP32-S3
#define OLED_ADDR 0x3C
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define STEP_WINDOW_MS 600000UL
#define IMU_SAMPLE_MS 20UL       // 50 Hz accelerometer sampling for step detection
#define LIGHT_SAMPLE_MS 30000UL  // BH1750 sampled every 30 seconds
#define DISPLAY_MS 1000UL
#define SYNC_MS 10000UL
#define ACK_TIMEOUT_MS 5000UL
#define STEP_THRESHOLD 1.15f

Adafruit_MPU6050 mpu;
BH1750 lightMeter;
Adafruit_SSD1306 oled(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
WiFiClient net; PubSubClient mqtt(net); Preferences prefs;
String topicEvent = String("petlink/") + DEVICE_ID + "/event";
String topicStatus = String("petlink/device/status/") + DEVICE_ID;
String topicAck = "petlink/device/ack";
String inflight=""; unsigned long sentAt=0, lastImu=0, lastLight=0, lastDisplay=0, lastSync=0, windowStart=0;
uint32_t seq=0; int steps=0, windowSteps=0; float luxSum=0; int luxCount=0; float maxUv=0;
bool abovePeak=false; unsigned long lastPeak=0; bool timeReady=false;
int menu=0; const char* menuItems[]={"Water done","Meal done","Mood check-in"};
unsigned long lastNext=0,lastSelect=0; bool sensorsOK=false;

String eventPath(uint32_t n){ char b[40]; snprintf(b,sizeof(b),"/q/%08lu.json",(unsigned long)n); return String(b); }
String newEventId(){ seq++; prefs.putUInt("seq",seq); char b[80]; snprintf(b,sizeof(b),"%s-%08lu",DEVICE_ID,(unsigned long)seq); return String(b); }
bool queueEvent(const String& json){ if(!LittleFS.exists("/q")) LittleFS.mkdir("/q"); int count=0; File d=LittleFS.open("/q"); for(File f=d.openNextFile();f;f=d.openNextFile()) if(!f.isDirectory()) count++; if(count>=200)return false; String id; JsonDocument doc; if(deserializeJson(doc,json))return false; id=String((const char*)doc["event_id"]); int dash=id.lastIndexOf('-'); uint32_t n=id.substring(dash+1).toInt(); File f=LittleFS.open(eventPath(n),"w"); if(!f)return false; f.print(json); f.close(); return true; }
bool oldestEvent(String& id,String& json){ File d=LittleFS.open("/q"); if(!d)return false; uint32_t minN=UINT32_MAX; while(File f=d.openNextFile()){ String nm=f.name(); uint32_t n=nm.substring(nm.lastIndexOf('/')+1, nm.lastIndexOf('.')).toInt(); if(n>0 && n<minN)minN=n; } if(minN==UINT32_MAX)return false; File f=LittleFS.open(eventPath(minN),"r"); if(!f)return false; json=f.readString(); f.close(); JsonDocument doc; if(deserializeJson(doc,json))return false; id=String((const char*)doc["event_id"]); return true; }
void ackCallback(char* topic, byte* payload,unsigned int len){ if(String(topic)!=topicAck)return; JsonDocument d; if(deserializeJson(d,payload,len))return; String id=d["eventId"]|""; if(id==inflight){ int dash=id.lastIndexOf('-'); uint32_t n=id.substring(dash+1).toInt(); LittleFS.remove(eventPath(n)); inflight=""; } }
void publishStatus(bool online,const char* reason=""){ JsonDocument d; d["deviceId"]=DEVICE_ID; d["online"]=online; d["reason"]=reason; d["pending"]=0; char b[180]; serializeJson(d,b); mqtt.publish(topicStatus.c_str(),b,true); }
void connectWifi(){ if(WiFi.status()==WL_CONNECTED)return; WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID,WIFI_PASSWORD); unsigned long t=millis(); while(WiFi.status()!=WL_CONNECTED && millis()-t<12000)delay(250); if(WiFi.status()==WL_CONNECTED){ configTime(19800,0,"pool.ntp.org","time.nist.gov"); time_t now=time(nullptr); timeReady=now>1700000000; } }
void connectMqtt(){ if(mqtt.connected()||WiFi.status()!=WL_CONNECTED)return; String will=String("{\"deviceId\":\"")+DEVICE_ID+"\",\"online\":false,\"reason\":\"connection_lost\"}"; bool ok = (strlen(MQTT_USERNAME)>0) ? mqtt.connect(DEVICE_ID,MQTT_USERNAME,MQTT_PASSWORD,topicStatus.c_str(),1,true,will.c_str()) : mqtt.connect(DEVICE_ID,nullptr,nullptr,topicStatus.c_str(),1,true,will.c_str()); if(ok){ mqtt.subscribe(topicAck.c_str(),1); publishStatus(true); } }
void render(){ oled.clearDisplay(); oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE); oled.setCursor(0,0); oled.println("PETLINK BAND"); oled.print("Steps: "); oled.println(steps); oled.print("Lux: "); oled.println(luxCount?luxSum/luxCount:0,0); oled.println("NEXT: habit menu"); oled.println(menuItems[menu]); oled.println("SELECT: log habit"); oled.display(); }
void makeEvent(const char* habit,bool verified,int eventSteps,float avgLux,float uv){ String id=newEventId(); JsonDocument d; d["device_id"]=DEVICE_ID; d["event_id"]=id; d["habit_id"]=habit; d["ts"]=(uint32_t)time(nullptr); d["ts_source"]=timeReady?"ntp":"local"; d["verified"]=verified; time_t nowLocal=time(nullptr); struct tm tmLocal; localtime_r(&nowLocal,&tmLocal); bool daytime=timeReady && tmLocal.tm_hour>=6 && tmLocal.tm_hour<20; d["daytime"]=daytime; JsonObject data=d["data"].to<JsonObject>(); data["steps"]=eventSteps; data["avg_lux"]=avgLux; data["max_uv"]=uv; data["window_s"]=600; String json; serializeJson(d,json); if(!queueEvent(json)) Serial.println("Queue full/write failed"); }
void syncQueue(){ if(!mqtt.connected())return; if(inflight.length() && millis()-sentAt<ACK_TIMEOUT_MS)return; if(inflight.length())inflight=""; String id,json; if(!oldestEvent(id,json))return; if(mqtt.publish(topicEvent.c_str(),json.c_str(),false)){ inflight=id; sentAt=millis(); } }
void setup(){ Serial.begin(115200); pinMode(NEXT_PIN,INPUT_PULLUP); pinMode(SELECT_PIN,INPUT_PULLUP); Wire.begin(SDA_PIN,SCL_PIN); oled.begin(SSD1306_SWITCHCAPVCC,OLED_ADDR); oled.clearDisplay(); oled.display(); sensorsOK=mpu.begin() && lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE); if(!sensorsOK)Serial.println("Sensor init issue; check I2C wiring"); mpu.setAccelerometerRange(MPU6050_RANGE_4_G); mpu.setFilterBandwidth(MPU6050_BAND_21_HZ); LittleFS.begin(true); LittleFS.mkdir("/q"); prefs.begin("petlink_band",false); seq=prefs.getUInt("seq",0); mqtt.setServer(MQTT_HOST,MQTT_PORT); mqtt.setCallback(ackCallback); mqtt.setBufferSize(512); windowStart=millis(); connectWifi(); connectMqtt(); render(); }
void loop(){ if(WiFi.status()!=WL_CONNECTED)connectWifi(); if(!mqtt.connected())connectMqtt(); mqtt.loop(); unsigned long now=millis();
 if(now-lastImu>=IMU_SAMPLE_MS){ lastImu=now; sensors_event_t a,g,t; mpu.getEvent(&a,&g,&t); float mag=sqrt(a.acceleration.x*a.acceleration.x+a.acceleration.y*a.acceleration.y+a.acceleration.z*a.acceleration.z)/9.80665f; if(mag>STEP_THRESHOLD && !abovePeak){ if(now-lastPeak>300){ steps++; windowSteps++; lastPeak=now; } abovePeak=true; } if(mag<1.05f) abovePeak=false; }
 if(now-lastLight>=LIGHT_SAMPLE_MS){ lastLight=now; float lux=lightMeter.readLightLevel(); if(lux>=0){luxSum+=lux;luxCount++;} }
 if(now-lastDisplay>=DISPLAY_MS){ lastDisplay=now; render(); }
 if(now-windowStart>=STEP_WINDOW_MS){ float avg=luxCount?luxSum/luxCount:0; bool verified=windowSteps>=600 && avg>=5000; if(windowSteps>0)makeEvent("outdoor_walk",verified,windowSteps,avg,maxUv); windowSteps=0; luxSum=0;luxCount=0;maxUv=0;windowStart=now; }
 if(digitalRead(NEXT_PIN)==LOW && now-lastNext>250){menu=(menu+1)%3;lastNext=now;render();}
 if(digitalRead(SELECT_PIN)==LOW && now-lastSelect>250){ const char* h=(menu==0?"water":menu==1?"meals":"mood"); makeEvent(h,false,steps,luxCount?luxSum/luxCount:0,0); lastSelect=now; render(); }
 if(now-lastSync>SYNC_MS){syncQueue();lastSync=now;}
}

