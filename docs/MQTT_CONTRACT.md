# PetLink MQTT contract

## Legacy hub topics (kept for compatibility)
- `petlink/habitat/light` hub light readings
- `petlink/device/rfid` RFID UID scan
- `petlink/device/habit` hub-button habit confirmation
- `petlink/device/display` backend-to-hub OLED message

## Wearable topics
- `petlink/{device_id}/event` device-to-backend event (QoS 1 recommended)
- `petlink/device/status/{device_id}` retained status + Last Will
- `petlink/device/ack` backend-to-device event acknowledgement

Example event: `{"device_id":"band_01","event_id":"band_01-00000001","habit_id":"outdoor_walk","ts":1795000000,"ts_source":"ntp","verified":true,"daytime":true,"data":{"steps":812,"avg_lux":18200,"max_uv":0,"window_s":600}}`

The backend deduplicates by event_id and attributes wearable events using the current device-to-player assignment created by an RFID scan at the hub.
