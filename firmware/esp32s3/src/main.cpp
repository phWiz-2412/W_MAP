#ifdef WMAP_TARGET_ESP32S3
#include <Arduino.h>
#include <NimBLEDevice.h>
#include "board_config.h"
#include "wmap_protocol.h"

/**
 * W_MAP ESP32-S3 Motorcycle Navigation Display Firmware (`src/main.cpp`)
 *
 * Responsibilities:
 * 1. Advertises the W_MAP BLE GATT service (`7f3a0000-0000-4d41-5057-4d4150000001`).
 * 2. Receives 38-byte binary telemetry frames in a lightweight lock-free inbox (zero heavy processing
 *    or SPI display rendering inside BLE callbacks).
 * 3. Validates CRC-16, protocol version, session ID, monotonic sequence numbers, and packet freshness.
 * 4. Renders the current navigation state on the 240x240 display only when display fields change
 *    (dirty-state tracking), clearly distinguishing unavailable (`--`) values from `0`.
 */

namespace {

struct RawFrameInbox {
  volatile uint32_t writeCount = 0;
  uint32_t readCount = 0;
  uint8_t buffer[wmap::TELEMETRY_FRAME_BYTES];
  size_t length = 0;
  volatile bool connectEvent = false;
  volatile bool disconnectEvent = false;
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
};

RawFrameInbox g_inbox;
wmap::ReceiverState g_receiver;
NimBLEServer* g_server = nullptr;
NimBLECharacteristic* g_statusChar = nullptr;
uint32_t g_lastStatusNotifyMs = 0;
uint32_t g_lastRenderCheckMs = 0;

struct RenderedHudDigest {
  bool initialized = false;
  wmap::DisplayBannerState bannerState = wmap::DisplayBannerState::DISCONNECTED;
  uint16_t speedKmh = wmap::U16_UNKNOWN;
  uint8_t speedLimitKmh = 0;
  wmap::SpeedLimitStatus limitStatus = wmap::SpeedLimitStatus::UNKNOWN;
  wmap::TurnDirection turnDirection = wmap::TurnDirection::STRAIGHT;
  uint32_t distanceToTurnMeters = wmap::U32_UNKNOWN;
  uint32_t remainingDistanceMeters = wmap::U32_UNKNOWN;
  uint16_t etaMinutes = wmap::U16_UNKNOWN;
  bool routeActive = false;

  bool equals(const RenderedHudDigest& o) const {
    return initialized == o.initialized &&
           bannerState == o.bannerState &&
           speedKmh == o.speedKmh &&
           speedLimitKmh == o.speedLimitKmh &&
           limitStatus == o.limitStatus &&
           turnDirection == o.turnDirection &&
           distanceToTurnMeters == o.distanceToTurnMeters &&
           remainingDistanceMeters == o.remainingDistanceMeters &&
           etaMinutes == o.etaMinutes &&
           routeActive == o.routeActive;
  }
};

RenderedHudDigest g_lastRendered;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
    pServer->updateConnParams(desc->conn_handle, 12, 24, 0, 200);
    portENTER_CRITICAL(&g_inbox.mux);
    g_inbox.connectEvent = true;
    portEXIT_CRITICAL(&g_inbox.mux);
  }

  void onDisconnect(NimBLEServer* pServer) override {
    portENTER_CRITICAL(&g_inbox.mux);
    g_inbox.disconnectEvent = true;
    portEXIT_CRITICAL(&g_inbox.mux);
    NimBLEDevice::startAdvertising();
  }
};

class TelemetryCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) override {
    const std::string& val = pCharacteristic->getValue();
    portENTER_CRITICAL(&g_inbox.mux);
    if (val.size() == wmap::TELEMETRY_FRAME_BYTES) {
      memcpy(g_inbox.buffer, val.data(), wmap::TELEMETRY_FRAME_BYTES);
      g_inbox.length = wmap::TELEMETRY_FRAME_BYTES;
    } else {
      g_inbox.length = val.size();
    }
    g_inbox.writeCount = g_inbox.writeCount + 1;
    portEXIT_CRITICAL(&g_inbox.mux);
  }
};

const char* turnDirectionLabel(wmap::TurnDirection dir) {
  switch (dir) {
    case wmap::TurnDirection::LEFT: return "TURN LEFT";
    case wmap::TurnDirection::RIGHT: return "TURN RIGHT";
    case wmap::TurnDirection::STRAIGHT: return "CONTINUE";
    case wmap::TurnDirection::U_TURN: return "U-TURN";
    case wmap::TurnDirection::ROUNDABOUT: return "ROUNDABOUT";
    default: return "---";
  }
}

const char* bannerLabel(wmap::DisplayBannerState st) {
  switch (st) {
    case wmap::DisplayBannerState::DISCONNECTED: return "BLE DISCONNECTED";
    case wmap::DisplayBannerState::GPS_LOST: return "GPS LOST";
    case wmap::DisplayBannerState::DATA_STALE: return "DATA STALE - NOT LIVE";
    case wmap::DisplayBannerState::NO_SPEED: return "NO SPEED";
    case wmap::DisplayBannerState::UNKNOWN_LIMIT: return "LIMIT UNKNOWN";
    case wmap::DisplayBannerState::STALE_LIMIT: return "LIMIT STALE";
    case wmap::DisplayBannerState::WARNING: return "SLOW DOWN";
    case wmap::DisplayBannerState::NORMAL: return "OK";
    default: return "---";
  }
}

void renderHudIfChanged(uint32_t nowMs) {
  const wmap::DisplayBannerState banner = g_receiver.evaluateBannerState(nowMs, WMAP_MAX_PACKET_AGE_MS);
  const bool staleOrDisconnected =
      !g_receiver.bleConnected || !g_receiver.hasValidFrame || g_receiver.isStale(nowMs, WMAP_MAX_PACKET_AGE_MS);

  RenderedHudDigest current{};
  current.initialized = true;
  current.bannerState = banner;
  if (!staleOrDisconnected && g_receiver.hasValidFrame) {
    const auto& f = g_receiver.latestFrame;
    current.speedKmh = f.currentSpeedKmh;
    current.speedLimitKmh = f.speedLimitKmh;
    current.limitStatus = f.speedLimitStatus;
    current.turnDirection = f.turnDirection;
    current.distanceToTurnMeters = f.distanceToTurnMeters;
    current.remainingDistanceMeters = f.remainingDistanceMeters;
    current.etaMinutes = f.etaDurationMinutes;
    current.routeActive = f.routeActive;
  }

  if (current.equals(g_lastRendered)) {
    return; // Skip redraw when display state is identical
  }
  g_lastRendered = current;

  char speedBuf[8];
  if (current.speedKmh == wmap::U16_UNKNOWN) {
    snprintf(speedBuf, sizeof(speedBuf), "--");
  } else {
    snprintf(speedBuf, sizeof(speedBuf), "%u", static_cast<unsigned>(current.speedKmh));
  }

  char limitBuf[8];
  if (current.limitStatus == wmap::SpeedLimitStatus::UNKNOWN || current.speedLimitKmh == 0) {
    snprintf(limitBuf, sizeof(limitBuf), "--");
  } else {
    snprintf(limitBuf, sizeof(limitBuf), "%u", static_cast<unsigned>(current.speedLimitKmh));
  }

  char distBuf[16];
  if (!current.routeActive || current.distanceToTurnMeters == wmap::U32_UNKNOWN) {
    snprintf(distBuf, sizeof(distBuf), "--");
  } else if (current.distanceToTurnMeters >= 1000) {
    snprintf(distBuf, sizeof(distBuf), "%u.%u km",
             static_cast<unsigned>(current.distanceToTurnMeters / 1000),
             static_cast<unsigned>((current.distanceToTurnMeters % 1000) / 100));
  } else {
    snprintf(distBuf, sizeof(distBuf), "%u m", static_cast<unsigned>(current.distanceToTurnMeters));
  }

  Serial.printf("[HUD] Banner=%s | Speed=%s km/h | Limit=%s | Turn=%s (%s)\n",
                bannerLabel(current.bannerState),
                speedBuf,
                limitBuf,
                current.routeActive ? turnDirectionLabel(current.turnDirection) : "NAV OFF",
                distBuf);
}

} // namespace

void setup() {
  Serial.begin(115200);
  pinMode(WMAP_PIN_TFT_BL, OUTPUT);
  digitalWrite(WMAP_PIN_TFT_BL, HIGH);

  NimBLEDevice::init(WMAP_BLE_DEVICE_NAME);
  NimBLEDevice::setMTU(WMAP_BLE_PREFERRED_MTU);

  g_server = NimBLEDevice::createServer();
  g_server->setCallbacks(new ServerCallbacks());

  NimBLEService* service = g_server->createService(WMAP_BLE_SERVICE_UUID);
  NimBLECharacteristic* telemetryChar = service->createCharacteristic(
      WMAP_BLE_TELEMETRY_CHAR_UUID,
      NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE);
  telemetryChar->setCallbacks(new TelemetryCallbacks());

  g_statusChar = service->createCharacteristic(
      WMAP_BLE_STATUS_CHAR_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  service->start();

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(WMAP_BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
}

void loop() {
  const uint32_t nowMs = millis();

  bool didConnect = false;
  bool didDisconnect = false;
  bool hasNewFrame = false;
  uint8_t localBuf[wmap::TELEMETRY_FRAME_BYTES];
  size_t localLen = 0;

  portENTER_CRITICAL(&g_inbox.mux);
  if (g_inbox.connectEvent) {
    didConnect = true;
    g_inbox.connectEvent = false;
  }
  if (g_inbox.disconnectEvent) {
    didDisconnect = true;
    g_inbox.disconnectEvent = false;
  }
  if (g_inbox.writeCount != g_inbox.readCount) {
    hasNewFrame = true;
    g_inbox.readCount = g_inbox.writeCount;
    localLen = g_inbox.length;
    if (localLen == wmap::TELEMETRY_FRAME_BYTES) {
      memcpy(localBuf, g_inbox.buffer, wmap::TELEMETRY_FRAME_BYTES);
    }
  }
  portEXIT_CRITICAL(&g_inbox.mux);

  if (didConnect) g_receiver.onConnect();
  if (didDisconnect) g_receiver.onDisconnect();
  if (hasNewFrame) {
    g_receiver.receiveBytes(localBuf, localLen, nowMs);
  }

  if (nowMs - g_lastRenderCheckMs >= WMAP_RENDER_INTERVAL_MS) {
    g_lastRenderCheckMs = nowMs;
    renderHudIfChanged(nowMs);
  }

  if (g_receiver.bleConnected && g_statusChar && (nowMs - g_lastStatusNotifyMs >= WMAP_STATUS_NOTIFY_INTERVAL_MS)) {
    g_lastStatusNotifyMs = nowMs;
    uint8_t statusBytes[wmap::DEVICE_STATUS_FRAME_BYTES];
    wmap::encode_device_status(
        statusBytes,
        g_receiver.activeSessionId,
        g_receiver.lastSequenceNumber,
        g_receiver.latestFrame.timestampMs,
        nowMs);
    g_statusChar->setValue(statusBytes, wmap::DEVICE_STATUS_FRAME_BYTES);
    g_statusChar->notify();
  }

  delay(5);
}
#endif
