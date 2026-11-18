# Reminders: Hub → Station (MVP item 7)

The revised plan asks for "reminders pushed from the backend to the band". We don't have the
band or the vibration motor yet, so reminders go to the **station's OLED**. The message format
and topic follow the plan, so the band can reuse them later.

## How it works

```
 Backend scheduler (checks every 15 s)
   10:00 "Drink water!"  -> how many players haven't logged water today?  2
      |                     (none? -> skip, no reminder)
      v
 publish  petlink/esp32_petlink_station/cmd/reminder/water   (QoS 1, RETAINED)
   {"type":"reminder","id":"rem-1-2026-11-19-1000","habit_id":"water",
    "text":"Drink water!","remaining":2,"buzz":true,
    "ts":1763526600,"expires":1763533800}
      |
      v
 ESP32: OLED flashes 3x  ->  ** REMINDER **        then the idle screen keeps:
                             Drink water!           "Drink water! 2 left"
                             2 players to go
                             Any button = OK
      |
 A player logs water -> reminder_update {"remaining":1}  -> "Drink water! 1 left"
 Everyone logged it   -> empty retained message          -> line removed
```

## Privacy: the station is shared

Anyone walking past can read the station, so:

| Where | Shows | Why it's safe |
|---|---|---|
| Shared reminder (pop-up + idle line) | "Drink water! 2 left": a **count**, never names | Reveals nothing about any one person |
| After a player taps **their own card** | "Hi Alex! Still to do today: Daily Workout, Read Book" (2.5 s, then the habit menu) | Only the card holder triggers it |
| Website live OLED mirror | Everything except the personal to-do list | The website is shared too |

Names are never put in a reminder command at all. The backend sends only the count, so no one
listening on MQTT learns them either. The automated test checks this on every command.
This is **privacy by design**: shared devices show anonymous information, and personal details
appear only after the player identifies themselves.

## Details

- **Topic:** under the plan's command topic `petlink/{device_id}/cmd`, one sub-topic per habit:
  `.../cmd/reminder/water`, `.../cmd/reminder/reading`. The broker keeps **one** retained
  message per topic, so separate topics stop an update to one reminder from erasing another.
- **Format:** the plan's example command, plus `id`, `remaining`, `ts` and `expires`.
- **Only when needed:** skipped if every player already did the habit today.
- **Station offline at reminder time?** The command is *retained*, so on reconnect the broker
  hands over every reminder that is still active (cleared ones are gone). `expires` (2 h) stops
  a stale reminder from showing much later, and `id` (saved in NVS) stops the same pop-up from
  showing twice after a reconnect or reboot.
- **Player busy at the station?** The reminder waits until they finish, then shows.
- **Buzz:** `BUZZ_PIN` in `config.h` is `-1` (not fitted). When a vibration motor is wired
  through a transistor, set the pin and it buzzes along with the flash.

## Changing reminder times (no re-flashing)

Reminders live in the `reminders` table in SQLite. Defaults: water 10:00 and 15:00,
exercise 18:00, reading 21:00.

| Request | Does |
|---|---|
| `GET /api/reminders` | list all |
| `POST /api/reminders` `{"habitId":"water","time":"11:30","text":"Drink water!"}` | add one |
| `PATCH /api/reminders/1` `{"time":"09:15"}` or `{"enabled":false}` | change / switch off |
| `DELETE /api/reminders/1` | remove |
| `POST /api/reminders/1/send` (`?force=true` to ignore "everyone done") | send right now (demo) |

Example from a terminal (Mac/Linux; on Windows use `curl.exe` and `\"` inside the quotes):
```
curl -X POST http://localhost:3000/api/reminders/1/send
curl -X PATCH http://localhost:3000/api/reminders/1 -H "Content-Type: application/json" -d '{"time":"09:15"}'
```
Fields: `time` is "HH:MM" (24 h); `text` is 1-40 characters; `onlyIfNotDone`, `buzz` and
`enabled` are true or false. Bad input is rejected with a 400 error and a message.

## Files

| File | What |
|---|---|
| `backend/reminderService.js` | **New.** Reminders table + defaults, scheduler, anonymous "N still to go" count, publishes per-habit commands |
| `backend/server.js` | Starts the scheduler |
| `backend/routes/api.js` | `/api/reminders` endpoints |
| `backend/mqttService.js` | Adds the personal to-do list to the card-tap reply (hidden from the website mirror); tells reminders when a habit is logged |
| `esp32/petlink_esp32.ino` | Subscribes to `petlink/<id>/cmd/#`, pop-up + idle line (count only), updates/clears, personal to-do after card tap, ignores repeats and expired ones, waits if busy, button dismiss |
| `esp32/config.h` | `REMINDER_SHOW_MS`, optional `BUZZ_PIN` |
| `tests/reminder-test.js` | **New.** `npm run test:reminders` |

## Automated test (no hardware)

Stop the normal backend, then with Mosquitto running: `npm run test:reminders`

| Test | Result |
|---|---|
| Default reminders are stored | PASS: 4 reminders |
| Invalid reminders are rejected | PASS: bad time / habit / text → 400 |
| Manual reminder reaches the station | PASS: about 4 ms on a local broker, correct format, `remaining: 4` |
| Scheduled reminder fires once at its time | PASS: received exactly 1 time |
| Count updates as players finish, then clears | PASS: 3 → 2 → 1 → cleared |
| Privacy: no names in reminders, to-do only after card tap | PASS: no command contains a name; card tap shows that player's own list |
| Skipped when everyone already did it | PASS: nothing published |
| Offline station gets active reminders on reconnect | PASS: active one delivered, cleared one not |
| Times changed without re-flashing | PASS: PATCH / DELETE work, bad input rejected |

## Hardware test plan

| # | Do this | Expected |
|---|---|---|
| 1 | `POST /api/reminders/1/send` | OLED flashes, shows "Drink water!" and "N players to go". **No names.** Serial: `[Reminder] rem-1-...` |
| 2 | Press any button | Back to idle; bottom line shows "Drink water! N left". The button does nothing else |
| 2b | Tap a card, then log water | First "Hi <name>! Still to do today: ...", then the habit menu. After CONFIRM the idle line drops to "N-1 left" |
| 3 | Set a reminder 2 minutes ahead (`PATCH ... {"time":"HH:MM"}`) and wait | Shows at that minute, once |
| 4 | Tap a card, start choosing a habit, then send a reminder | Shows only after the habit is submitted |
| 5 | Turn the hotspot off, send a reminder, turn the hotspot on | Shows once the station reconnects |
| 6 | Press the ESP32 reset button | The same reminder does **not** show again |
| 7 | Log water for every player | Reminder line disappears. Sending the water reminder again is skipped (backend log) |

## Limits
- One shared station: a reminder only reaches whoever is near it. The idle line keeps it
  visible for 2 h, and each player sees their own list when they tap their card. With the
  wearable bands from the plan, each band would get personal reminders on its own
  `petlink/<band_id>/cmd`.
- Reminders fire within about 15 s of the set minute (scheduler interval).
- Without NTP time (station rebooted offline), `expires` can't be checked, so a retained
  reminder may show late once.
