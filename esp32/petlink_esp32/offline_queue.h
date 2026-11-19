/**
 * =========================================================================
 * PetLink - Offline Queue (store-and-forward)
 * =========================================================================
 * Every confirmed habit is written to the ESP32's flash (LittleFS) BEFORE it
 * is sent. It is only deleted when the backend sends back an ACK for its
 * eventId. So if Wi-Fi or the broker is down, nothing is lost: the event
 * waits in flash (even across reboots / power cuts) and is re-sent later.
 *
 * Files:   /q/00000042.json   (one small JSON file per pending event)
 * IDs:     "<deviceId>-00000042"  - the number is a counter kept in NVS
 *          (non-volatile storage), so IDs never repeat even after a reboot.
 * =========================================================================
 */
#ifndef OFFLINE_QUEUE_H
#define OFFLINE_QUEUE_H

#include <Arduino.h>

namespace OfflineQueue {

  // Max events kept in flash. When full, new events are refused (not silently lost).
  const int MAX_EVENTS = 200;

  // Mount LittleFS (formats it on first use), load the event counter,
  // count pending events. Call once in setup().
  bool begin(const char* deviceId);

  // Next unique event id, e.g. "esp32_petlink_station-00000042".
  String nextEventId();

  // Save an event to flash. Returns false if flash is full or write failed.
  bool push(const String& eventId, const String& json);

  // Oldest pending event (events are sent in the order they happened).
  bool peekOldest(String& eventId, String& json);

  // Delete an event after the backend acknowledged it.
  bool remove(const String& eventId);

  // How many events are still waiting to be delivered.
  int pending();
}

#endif // OFFLINE_QUEUE_H
