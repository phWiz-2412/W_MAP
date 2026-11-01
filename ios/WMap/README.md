# W_MAP Native iOS Companion Application (`ios/WMap`)

Native Swift / SwiftUI iOS companion application for **W_MAP**. Acts as the **Navigation Computer** (Core Location GPS, Google Places/Routes pre-trip planning, turn-by-turn route evaluation) and **BLE GATT Central** transmitting 38-byte binary telemetry frames (`7f3a0001-0000-4d41-5057-4d4150000001`) to the ESP32-S3 handlebar display.

> **Platform Build Note:** Compiling, code-signing, and deploying a native iOS application to a physical iPhone requires **macOS with Xcode 15/16+** and an Apple Developer account. On a Windows-only machine, use the HTTPS Safari companion page (`npm run dev:phone` → `https://<PC-IP>:5173/phone.html`) for live iPhone GPS testing.

---

## 1. Required `Info.plist` Keys

When opening `ios/WMap` in Xcode on macOS, ensure the app target's `Info.plist` includes:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>W_MAP uses your precise GPS location and speed to compute turn-by-turn motorcycle navigation updates for your handlebar display.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>W_MAP uses background location while a navigation trip is active so your handlebar display continues receiving turn updates with the phone screen locked in your pocket.</string>
<key>NSBluetoothAlwaysUsageDescription</key>
<string>W_MAP connects to your ESP32-S3 motorcycle display over Bluetooth Low Energy (BLE) to transmit turn-by-turn navigation telemetry.</string>
<key>UIBackgroundModes</key>
<array>
  <string>location</string>
  <string>bluetooth-central</string>
</array>
```

---

## 2. Running Unit Tests on macOS / Swift Toolchain

```bash
cd ios/WMap
swift test
```

The `BleProtocolTests` XCTest suite verifies that `BleProtocolCodec.encodeTelemetry` produces the exact same 38-byte hex payloads (`0101241007...` and `0101241008...`) as TypeScript (`packages/navigation-core/tests/bleProtocol.test.ts`) and ESP32-S3 C++ (`firmware/esp32s3/test/test_protocol.cpp`).
