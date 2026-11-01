# BLE protocol (DRAFT v1 – design only)

> Status: **designed, not implemented, not tested on hardware.** Phase 1 only exercises the *JSON* form inside the browser simulator. All UUIDs below are **project-defined placeholders for W_MAP**; they are not taken from, and make no claim of compatibility with, any other project or SIG-assigned UUID. Generate final random 128-bit UUIDs before building firmware/iOS.

## GATT layout

| Item | UUID (placeholder) | Properties | Direction |
|---|---|---|---|
| W_MAP Navigation Service | `7f3a0000-0000-4d41-5057-4d4150000001` | – | ESP32 is the GATT peripheral/server |
| Navigation Data characteristic | `7f3a0001-0000-4d41-5057-4d4150000001` | Write Without Response | iPhone → ESP32 |
| Device Status characteristic | `7f3a0002-0000-4d41-5057-4d4150000001` | Read, Notify | ESP32 → iPhone |

Device Status carries: protocol version, firmware version, last accepted sequence, display mode, battery/health flags (TBD).

## Packet versioning

First byte of every binary payload is the protocol version (`1`). Receivers reject unknown versions. The JSON form has `{"version":1,"data":{…}}`.

## JSON form (debug / simulator; implemented in `navigation-core`)

```json
{
  "version": 1,
  "data": {
    "sequenceNumber": 42, "timestamp": 1730430000000,
    "currentSpeedKmh": 45, "speedLimitKmh": 50,
    "turnDirection": "RIGHT", "distanceToTurnMeters": 350,
    "latitude": 21.0285, "longitude": 105.8542, "headingDegrees": 90,
    "gpsStatus": "ACTIVE", "bleStatus": "CONNECTED", "routeStatus": "ACTIVE",
    "speedLimitStatus": "VALID",
    "routePoints": [{"latitude": 21.0285, "longitude": 105.8542}]
  }
}
```

`speedLimitKmh` is `null` when unknown (status `UNKNOWN`); never `0`. Status `STALE` requires a value but marks it unverified.

## Compact binary form (proposed, not implemented)

Little-endian. Core frame, 24 bytes:

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | version (1) |
| 1 | u8 | flags: bit0 gps ACTIVE, bit1 nav ACTIVE, bits2–3 limit status (0 unknown, 1 valid, 2 stale) |
| 2 | u16 | sequenceNumber (wraps) |
| 4 | u32 | timestamp (ms, sender monotonic or epoch low 32 bits) |
| 8 | u8 | speed km/h (`0xFF` = null) |
| 9 | u8 | speed limit km/h (`0` = unknown) |
| 10 | u8 | turn (0 LEFT, 1 RIGHT, 2 STRAIGHT, 3 U_TURN) |
| 11 | u8 | reserved |
| 12 | u16 | distance to turn, m (`0xFFFF` = null) |
| 14 | u16 | heading, 0.1° units (`0xFFFF` = null) |
| 16 | i32 | latitude, 1e-6° (`INT32_MIN` = null) |
| 20 | i32 | longitude, 1e-6° (`INT32_MIN` = null) |

The BLE link state is known by the ESP32 itself, so `bleStatus` is not transmitted.

**Route geometry** does not fit the core frame. Proposed: a separate "route chunk" message type (type byte + index/count + up to N points as i32 pairs, or int16 deltas), sent only when the route changes. The simulator caps `routePoints` at 64 to keep this realistic.

## Size

- Default ATT MTU gives 20 bytes payload; negotiate a larger MTU (iOS commonly ~185, up to 512) and **never assume** it. 24-byte frame needs MTU ≥ 27 payload, so fragmentation or MTU negotiation is mandatory; the firmware must reject truncated writes.
- JSON form is ~350+ bytes with route points – for debugging only.

## Validation rules (both sides)

Reject: wrong version/length; speed outside 0–300; limit 0 or >200; distance <0 or >100 000; lat/lon out of range or only one set; heading outside [0,360); invalid enums; inconsistent limit status (UNKNOWN with value, VALID/STALE without). The TypeScript reference is `packages/navigation-core/src/validation`.

## Sequence, freshness and stale handling

- Sequence strictly increases (u16 wrap handled with serial-number arithmetic on device). Duplicates and older packets are dropped.
- Send rate: 1–2 Hz heartbeat, immediately on a maneuver change. Heartbeats keep data fresh.
- The receiver judges freshness by **local time since last accepted packet** (and, in the simulator, packet timestamp age): older than ~3 s ⇒ DATA_STALE, shown explicitly; link drop ⇒ DISCONNECTED shown explicitly.
- Speed-limit staleness is a sender-provided status; the display never shows a stale/unknown limit as verified.

## Reconnection

Peripheral re-advertises after disconnect; central reconnects (iOS state restoration). On reconnect the iPhone resends a full state immediately; the device resets its sequence gate on a fresh connection.
