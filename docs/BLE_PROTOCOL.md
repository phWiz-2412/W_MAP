# BLE Protocol Specification (v1 — Implemented Binary & JSON Contracts)

> **Status:**
> - **Implemented & unit-tested** in TypeScript ([`packages/navigation-core/src/ble/bleProtocol.ts`](file:///f:/W_MAP/packages/navigation-core/src/ble/bleProtocol.ts)), ESP32-S3 C++17 ([`firmware/esp32s3/include/wmap_protocol.h`](file:///f:/W_MAP/firmware/esp32s3/include/wmap_protocol.h)), and iOS Swift ([`ios/WMap/Sources/WMapCore/BleProtocolCodec.swift`](file:///f:/W_MAP/ios/WMap/Sources/WMapCore/BleProtocolCodec.swift)) using shared golden test vectors (`BLE_GOLDEN_VECTORS`).
> - **Physical BLE hardware status:** Pending physical ESP32-S3 board and macOS/Xcode deployment to a physical iPhone.

---

## 1. GATT Service & Characteristics

| Item | UUID | Properties | Direction | Purpose |
|---|---|---|---|---|
| **W_MAP Navigation Service** | `7f3a0000-0000-4d41-5057-4d4150000001` | Primary Service | ESP32-S3 is GATT Peripheral | Discovery & connection service |
| **Navigation Telemetry Char** | `7f3a0001-0000-4d41-5057-4d4150000001` | `Write Without Response`, `Write` | iPhone → ESP32-S3 | 38-byte binary telemetry frame (1 Hz heartbeat + immediate maneuver updates) |
| **Route Geometry Chunk Char** | `7f3a0002-0000-4d41-5057-4d4150000001` | `Write` (with response) | iPhone → ESP32-S3 | Chunked compact route polyline (sent only when route starts or changes) |
| **Device Status & Ack Char** | `7f3a0003-0000-4d41-5057-4d4150000001` | `Read`, `Notify` | ESP32-S3 → iPhone | 16-byte status/ack heartbeat (last accepted seq, session ID, uptime) |

---

## 2. Binary Telemetry Frame (38 Bytes, Little-Endian)

| Offset | Size | Type | Field | Encoding & Sentinel Rules |
|---|---|---|---|---|
| `0` | 1 | `u8` | `version` | Must be `1` (`PROTOCOL_VERSION`) |
| `1` | 1 | `u8` | `msgType` | `0x01` (`BLE_MSG_TYPE_TELEMETRY`) |
| `2..3` | 2 | `u16` | `sessionId` | Non-zero session ID (`1..65535`). Resets sequence gate when changed. |
| `4..5` | 2 | `u16` | `sequenceNumber` | Monotonic counter (`0..65535`) within `sessionId`. |
| `6..9` | 4 | `u32` | `timestampMs` | Sender monotonic timestamp (ms, low 32 bits). |
| `10` | 1 | `u8` | `flags` | `bit0`: `gpsActive`<br>`bit1`: `routeActive`<br>`bits2..3`: `speedLimitStatus` (`0`=UNKNOWN, `1`=VALID, `2`=STALE)<br>`bit4`: `isOffRoute`<br>`bit5`: `hasArrived`<br>`bits6..7`: reserved (`0`) |
| `11` | 1 | `u8` | `turnDirection` | `0`=LEFT, `1`=RIGHT, `2`=STRAIGHT, `3`=U_TURN, `4`=ROUNDABOUT |
| `12..13` | 2 | `u16` | `currentSpeedKmh` | `0..300` km/h; `0xFFFF` = `null` (unavailable, never `0` for unknown) |
| `14` | 1 | `u8` | `speedLimitKmh` | `1..200` km/h; `0` = `null` (`UNKNOWN`) |
| `15` | 1 | `u8` | `gpsAccuracyMeters` | `0..254` m; `0xFF` = `null` |
| `16..19` | 4 | `u32` | `distanceToTurnMeters` | `0..100000` m; `0xFFFFFFFF` = `null` |
| `20..23` | 4 | `u32` | `remainingDistanceMeters` | `0..1000000` m; `0xFFFFFFFF` = `null` |
| `24..25` | 2 | `u16` | `etaDurationMinutes` | `0..65534` min; `0xFFFF` = `null` |
| `26..27` | 2 | `u16` | `headingDeciDeg` | `0..3599` ($0.1^\circ$ units); `0xFFFF` = `null` |
| `28..31` | 4 | `i32` | `latitudeE6` | $\text{round}(\text{lat} \times 10^6)$; `INT32_MIN` (`-2147483648`) = `null` |
| `32..35` | 4 | `i32` | `longitudeE6` | $\text{round}(\text{lon} \times 10^6)$; `INT32_MIN` (`-2147483648`) = `null` |
| `36..37` | 2 | `u16` | `crc16` | `CRC-16/CCITT-FALSE` (`poly=0x1021, init=0xFFFF`) over bytes `0..35` |

---

## 3. Shared Golden Test Vectors (`BLE_GOLDEN_VECTORS`)

### Vector 0: Active Navigation in Đà Nẵng (`sessionId=0x1024, seq=7, speed=45 km/h, Turn Right in 180m, Remaining 8450m, ETA 14 min, limit UNKNOWN`)
```text
01012410070048e8010003012d000006b4000000022100000e009d03ac12f500806a7306650d
```

### Vector 1: GPS Lost & Route Inactive (`sessionId=0x1024, seq=8, all nullable fields set to explicit sentinel values`)
```text
01012410080030ec01000002ffff00ffffffffffffffffffffffffff0000008000000080ba0a
```

---

## 4. Latest-State Coalescing, Freshness & Reconnection Semantics

1. **Latest-State Coalescing (`BleLatestStateTxQueue`):**
   - If the meaningful navigation state (maneuver, speed, route status, GPS status, or turn distance change $\ge 3\text{ m}$) has not changed since the last transmission, redundant updates are skipped until `heartbeatIntervalMs` (`1000 ms`) elapses.
   - If the BLE GATT write channel is busy, new updates overwrite a single pending slot (`pendingFrame`) rather than building an unbounded backlog queue.
2. **Session & Sequence Protection (`BleReceiverStateMachine` / `wmap::ReceiverState`):**
   - Within the same `sessionId`, frames with `sequenceNumber <= lastSequenceNumber` are rejected as duplicates/out-of-order.
   - When the iPhone starts a new navigation session or reconnects with a new `sessionId`, the receiver resets `lastSequenceNumber` and increments `sessionResets`.
3. **Stale Detection:**
   - The receiver records local arrival time (`lastFrameReceivedAtMs`). If `nowMs - lastFrameReceivedAtMs > 3000 ms`, the display transitions to `DATA_STALE` (`"DATA STALE - NOT LIVE"`), hides live speed (`--`), and suppresses overspeed warnings.
