# Store-and-Forward (Offline Mode) for the PetLink Station

**Problem:** before this change, pressing CONFIRM sent the habit over MQTT once and hoped it
arrived (QoS 0, no retry). If the hotspot dropped, even briefly, the habit was lost and the
player was never told. While Wi-Fi was down, the reconnect loop also froze the station
(about 12 s per attempt), so the buttons and RFID reader stopped responding.

**Solution:** the station now works offline. Every habit is saved to the ESP32's flash first,
sent when possible, and deleted only after the backend confirms it was processed.

## How it works

```
 CONFIRM pressed
      |
      v
 1. Give it an id         station-00000042   (counter kept in NVS, never repeats)
 2. Save to flash         /q/00000042.json   (LittleFS, survives reboot/power cut)
 3. Online?  --no-->  OLED: "SAVED OFFLINE, 3 waiting to sync"
      | yes
      v
 4. Publish  petlink/device/habit   {eventId, uid, habit, ts, tsSource, replayed}
      |
      v
 Backend: seen this eventId before?
      |-- yes --> ignore it, just ACK again          (duplicate-proof)
      |-- no  --> log habit for the day it was DONE (ts), remember eventId, ACK
      v
 5. ACK on  petlink/device/ack  {deviceId, eventId, outcome}
      |
      v
 6. ESP32 deletes /q/00000042.json.   No ACK within 5 s? Send it again.
```

When the station comes back online, it sends the saved events one by one, oldest first,
and shows **SYNC COMPLETE** on the OLED.

### Online/offline status (MQTT Last Will + retained message)
- On connect, the ESP32 leaves a "will" with the broker:
  `petlink/device/status/<deviceId>` → `{"online":false,"reason":"connection_lost"}`.
- It then publishes `{"online":true,"ip":...,"pending":N}` on the same topic with **retain**.
- If the station dies (power cut, out of range), the **broker** publishes the will for it.
  With keep-alive set to 10 s, the broker notices within about 15 s. A clean TCP close is
  noticed immediately.
- The backend stores this in the `device_status` table, logs it, and emits `device_status` to
  the website. Check it at `http://localhost:3000/api/devices`.

### Why our own ACK instead of MQTT QoS 1?
PubSubClient (the ESP32 MQTT library) can only *publish* at QoS 0. Even with QoS 1, the
receipt would only say *the broker* got the message, not that *the backend* stored it. Our
ACK comes from the backend after the SQLite write, so it confirms delivery end to end.

## Files

| File | What changed |
|---|---|
| `esp32/offline_queue.h/.cpp` | **New.** Flash queue (LittleFS) + unique event ids (NVS counter) |
| `esp32/petlink_esp32.ino` | Saves before sending, flushes the queue, handles ACKs, Last Will + retained status, non-blocking Wi-Fi, NTP time, offline OLED screens |
| `esp32/config.h` | Status/ACK topics, NTP + timing settings |
| `backend/deviceReliability.js` | **New.** `device_events` (dedup) + `device_status` tables, event date logic, validation |
| `backend/mqttService.js` | Dedup → process → record → ACK; status topic; no OLED spam for synced events |
| `database/db.js`, `backend/petLogic.js` | Optional `logDate` so a habit done offline counts for the right day |
| `backend/routes/api.js` | `GET /api/devices` |
| `tests/reliability-test.js` | **New.** Automated tests + CSV results |

Messages without an `eventId` (website buttons, old firmware) still work exactly as before.
No new Arduino libraries are needed: LittleFS and Preferences are built into the ESP32 core.

## Automated test (no hardware needed)

Stop the normal backend first, then with Mosquitto running:
```
npm run test:reliability
```
It starts its own backend on a temporary database and fakes the station.
Results from a development run (local broker):

| Test | Result | Detail |
|---|---|---|
| Duplicate delivery counted once | PASS | 3 copies → XP +15 once; ACKs: logged, duplicate, duplicate |
| Offline backlog syncs with no loss | PASS | 6/6 queued events logged |
| Re-sent backlog not double counted | PASS | XP change 0; 6/6 recognised as duplicates |
| Offline event keeps its real date | PASS | habit done "yesterday" logged under yesterday's date |
| Last Will marks a dead station offline | PASS | offline status received after the connection was killed |
| Round-trip latency event → ACK | PASS | n=20, avg ≈ 83 ms, max 88 ms |

Each run saves a CSV in `tests/results/`. Re-run it on the demo laptop for the report numbers.

## Hardware test plan (with the real station)

Open the Serial Monitor at **115200** baud and keep the backend console visible.

| # | Do this | Expected |
|---|---|---|
| 1 | Normal use: tap card, pick habit, CONFIRM | Logged as before. Serial shows `[Queue] Saved…` then `[Queue] Delivered…` |
| 2 | Turn the **phone hotspot off**, wait ~15 s | Backend: `[DEVICE] … is OFFLINE (connection_lost)`. OLED idle shows `OFFLINE mode` |
| 3 | While offline: tap card, log 2-3 habits | OLED `OFFLINE MODE` → habit menu → `SAVED OFFLINE, N waiting to sync` |
| 4 | Press the ESP32 **EN/reset** button while offline | Boot log: `[Queue] Ready. N event(s) waiting in flash` (nothing lost) |
| 5 | Turn the hotspot **on** | Backend: `ONLINE (…, N event(s) to sync)`, then each habit `synced from offline queue`. OLED: `SYNC COMPLETE` |
| 6 | Check the website / `/api/devices` | XP added once per habit; `events.replayed` = N |
| 7 | Repeat 2-5 five times, note N and whether every event arrived once | Table for the report: sent vs received vs duplicates |

Habits logged offline with an unknown card or already done that day are still ACKed
(outcome `rejected` / `already_done`), so they don't retry forever.

## Limits (state these in the report)
- If the ESP32 reboots **while offline**, it has no real time until NTP syncs again, so those
  events are sent with `tsSource: "none"` and count for the day they arrive.
- Offline, the station can't check whether a card is registered. That is checked on sync.
- Up to 200 events are kept in flash; when full, new ones are refused and the OLED says so.
- Events are sent one at a time (wait for ACK), which is simple and keeps order. That is fine
  for a station (~85 ms each) but would need batching for high-rate sensors.

## IoT concepts this covers
Store-and-forward and intermittent connectivity, write-ahead logging in flash, idempotent
(duplicate-safe) event handling, end-to-end acknowledgements, MQTT Last Will and retained
messages, keep-alive, NTP time synchronisation, and non-blocking firmware design.
