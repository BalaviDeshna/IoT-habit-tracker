/**
 * PetLink - Offline Queue implementation (see offline_queue.h)
 */
#include "offline_queue.h"
#include <FS.h>
#include <LittleFS.h>
#include <Preferences.h>

namespace {
  const char* QUEUE_DIR = "/q";
  String     g_deviceId;
  uint32_t   g_seq = 0;      // last used event number (persisted in NVS)
  int        g_pending = 0;
  Preferences g_prefs;

  // "/q/00000042.json"
  String pathFor(uint32_t seq) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%s/%08lu.json", QUEUE_DIR, (unsigned long)seq);
    return String(buf);
  }

  // "esp32_petlink_station-00000042" -> 42  (0 if malformed)
  uint32_t seqFromEventId(const String& eventId) {
    int dash = eventId.lastIndexOf('-');
    if (dash < 0) return 0;
    return (uint32_t)strtoul(eventId.c_str() + dash + 1, nullptr, 10);
  }

  // "00000042.json" -> 42
  uint32_t seqFromFileName(const String& name) {
    String base = name.substring(name.lastIndexOf('/') + 1);
    return (uint32_t)strtoul(base.c_str(), nullptr, 10);
  }

  String eventIdFor(uint32_t seq) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%s-%08lu", g_deviceId.c_str(), (unsigned long)seq);
    return String(buf);
  }

  int countFiles() {
    int n = 0;
    File dir = LittleFS.open(QUEUE_DIR);
    if (!dir || !dir.isDirectory()) return 0;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      if (!f.isDirectory()) n++;
    }
    return n;
  }
}

namespace OfflineQueue {

  bool begin(const char* deviceId) {
    g_deviceId = deviceId;

    // true = format the partition if it has never been used
    if (!LittleFS.begin(true)) {
      Serial.println("[Queue] ERROR: LittleFS mount failed. Offline queue disabled.");
      return false;
    }
    if (!LittleFS.exists(QUEUE_DIR)) LittleFS.mkdir(QUEUE_DIR);

    g_prefs.begin("petlink", false);
    g_seq = g_prefs.getUInt("seq", 0);
    g_pending = countFiles();

    Serial.printf("[Queue] Ready. %d event(s) waiting in flash, last event #%lu\n",
                  g_pending, (unsigned long)g_seq);
    return true;
  }

  String nextEventId() {
    g_seq++;
    g_prefs.putUInt("seq", g_seq);   // persist so ids never repeat after reboot
    return eventIdFor(g_seq);
  }

  bool push(const String& eventId, const String& json) {
    if (g_pending >= MAX_EVENTS) {
      Serial.println("[Queue] FULL - event refused.");
      return false;
    }
    uint32_t seq = seqFromEventId(eventId);
    if (seq == 0) return false;

    File f = LittleFS.open(pathFor(seq), "w");
    if (!f) {
      Serial.println("[Queue] ERROR: could not open file for writing.");
      return false;
    }
    size_t written = f.print(json);
    f.close();
    if (written != json.length()) {
      LittleFS.remove(pathFor(seq));
      Serial.println("[Queue] ERROR: flash write incomplete.");
      return false;
    }
    g_pending++;
    Serial.printf("[Queue] Saved %s (%d pending)\n", eventId.c_str(), g_pending);
    return true;
  }

  bool peekOldest(String& eventId, String& json) {
    File dir = LittleFS.open(QUEUE_DIR);
    if (!dir || !dir.isDirectory()) return false;

    uint32_t oldest = UINT32_MAX;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      if (f.isDirectory()) continue;
      uint32_t s = seqFromFileName(String(f.name()));
      if (s > 0 && s < oldest) oldest = s;
    }
    if (oldest == UINT32_MAX) {
      g_pending = 0;
      return false;
    }

    File f = LittleFS.open(pathFor(oldest), "r");
    if (!f) return false;
    json = f.readString();
    f.close();
    eventId = eventIdFor(oldest);
    return true;
  }

  bool remove(const String& eventId) {
    uint32_t seq = seqFromEventId(eventId);
    if (seq == 0) return false;
    String p = pathFor(seq);
    if (!LittleFS.exists(p)) return false;   // already removed (e.g. duplicate ACK)
    bool ok = LittleFS.remove(p);
    if (ok && g_pending > 0) g_pending--;
    Serial.printf("[Queue] Delivered %s (%d pending)\n", eventId.c_str(), g_pending);
    return ok;
  }

  int pending() {
    return g_pending;
  }
}
