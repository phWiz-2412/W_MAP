#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

/**
 * W_MAP Shared BLE v1 Binary Protocol & Receiver State Machine (`wmap_protocol.h`)
 *
 * Pure C/C++17 header-only implementation with zero hardware dependencies so it can be
 * compiled both for ESP32-S3 firmware and for host-side unit tests against the exact same
 * golden test vectors defined in `packages/navigation-core/src/ble/bleProtocol.ts`.
 */

namespace wmap {

constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint8_t MSG_TYPE_TELEMETRY = 0x01;
constexpr uint8_t MSG_TYPE_ROUTE_CHUNK = 0x02;
constexpr uint8_t MSG_TYPE_DEVICE_STATUS = 0x03;

constexpr size_t TELEMETRY_FRAME_BYTES = 38;
constexpr size_t DEVICE_STATUS_FRAME_BYTES = 16;

constexpr uint8_t U8_UNKNOWN = 0xFF;
constexpr uint16_t U16_UNKNOWN = 0xFFFF;
constexpr uint32_t U32_UNKNOWN = 0xFFFFFFFFUL;
constexpr int32_t I32_UNKNOWN = -2147483647 - 1; // INT32_MIN

constexpr uint16_t MAX_SPEED_KMH = 300;
constexpr uint8_t MAX_SPEED_LIMIT_KMH = 200;
constexpr uint32_t MAX_TURN_DISTANCE_M = 100000UL;
constexpr uint32_t MAX_REMAINING_DISTANCE_M = 1000000UL;

enum class TurnDirection : uint8_t {
  LEFT = 0,
  RIGHT = 1,
  STRAIGHT = 2,
  U_TURN = 3,
  ROUNDABOUT = 4,
};

enum class SpeedLimitStatus : uint8_t {
  UNKNOWN = 0,
  VALID = 1,
  STALE = 2,
};

enum class DisplayBannerState : uint8_t {
  DISCONNECTED = 0,
  GPS_LOST = 1,
  DATA_STALE = 2,
  NO_SPEED = 3,
  UNKNOWN_LIMIT = 4,
  STALE_LIMIT = 5,
  WARNING = 6,
  NORMAL = 7,
};

enum class DecodeError : uint8_t {
  OK = 0,
  INVALID_LENGTH = 1,
  CRC_MISMATCH = 2,
  UNSUPPORTED_VERSION = 3,
  INVALID_MSG_TYPE = 4,
  INVALID_SESSION_ID = 5,
  INVALID_FLAGS = 6,
  INVALID_TURN_DIRECTION = 7,
  SPEED_OUT_OF_RANGE = 8,
  SPEED_LIMIT_INVALID = 9,
  DISTANCE_OUT_OF_RANGE = 10,
  HEADING_OUT_OF_RANGE = 11,
  COORDINATE_OUT_OF_RANGE = 12,
  DUPLICATE_OR_OLD_SEQ = 13,
};

struct TelemetryFrame {
  uint8_t version;
  uint8_t msgType;
  uint16_t sessionId;
  uint16_t sequenceNumber;
  uint32_t timestampMs;
  bool gpsActive;
  bool routeActive;
  SpeedLimitStatus speedLimitStatus;
  bool isOffRoute;
  bool hasArrived;
  TurnDirection turnDirection;
  uint16_t currentSpeedKmh;      // U16_UNKNOWN when unavailable (never 0 for unknown)
  uint8_t speedLimitKmh;         // 0 when UNKNOWN
  uint8_t gpsAccuracyMeters;     // U8_UNKNOWN when unavailable
  uint32_t distanceToTurnMeters; // U32_UNKNOWN when unavailable
  uint32_t remainingDistanceMeters; // U32_UNKNOWN when unavailable
  uint16_t etaDurationMinutes;   // U16_UNKNOWN when unavailable
  uint16_t headingDeciDeg;       // 0..3599 (0.1 deg), U16_UNKNOWN when unavailable
  int32_t latitudeE6;            // I32_UNKNOWN when unavailable
  int32_t longitudeE6;           // I32_UNKNOWN when unavailable
};

inline uint16_t read_u16_le(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

inline uint32_t read_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

inline int32_t read_i32_le(const uint8_t* p) {
  return static_cast<int32_t>(read_u32_le(p));
}

inline void write_u16_le(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}

inline void write_u32_le(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFF);
}

inline uint16_t crc16_ccitt(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; ++i) {
    crc ^= static_cast<uint16_t>(data[i]) << 8;
    for (uint8_t b = 0; b < 8; ++b) {
      if ((crc & 0x8000) != 0) {
        crc = static_cast<uint16_t>((crc << 1) ^ 0x1021);
      } else {
        crc = static_cast<uint16_t>(crc << 1);
      }
    }
  }
  return crc;
}

inline DecodeError decode_telemetry(const uint8_t* bytes, size_t len, TelemetryFrame& out) {
  if (!bytes || len != TELEMETRY_FRAME_BYTES) {
    return DecodeError::INVALID_LENGTH;
  }
  const uint16_t expectedCrc = crc16_ccitt(bytes, 36);
  const uint16_t actualCrc = read_u16_le(bytes + 36);
  if (expectedCrc != actualCrc) {
    return DecodeError::CRC_MISMATCH;
  }

  const uint8_t version = bytes[0];
  if (version != PROTOCOL_VERSION) {
    return DecodeError::UNSUPPORTED_VERSION;
  }
  const uint8_t msgType = bytes[1];
  if (msgType != MSG_TYPE_TELEMETRY) {
    return DecodeError::INVALID_MSG_TYPE;
  }
  const uint16_t sessionId = read_u16_le(bytes + 2);
  if (sessionId == 0) {
    return DecodeError::INVALID_SESSION_ID;
  }

  const uint8_t flags = bytes[10];
  if ((flags & 0xC0) != 0) {
    return DecodeError::INVALID_FLAGS;
  }
  const uint8_t slBits = (flags >> 2) & 0x03;
  if (slBits > 2) {
    return DecodeError::INVALID_FLAGS;
  }
  const SpeedLimitStatus slStatus = static_cast<SpeedLimitStatus>(slBits);

  const uint8_t turnIdx = bytes[11];
  if (turnIdx > 4) {
    return DecodeError::INVALID_TURN_DIRECTION;
  }

  const uint16_t rawSpeed = read_u16_le(bytes + 12);
  if (rawSpeed != U16_UNKNOWN && rawSpeed > MAX_SPEED_KMH) {
    return DecodeError::SPEED_OUT_OF_RANGE;
  }

  const uint8_t rawLimit = bytes[14];
  if (rawLimit > MAX_SPEED_LIMIT_KMH) {
    return DecodeError::SPEED_LIMIT_INVALID;
  }
  if (slStatus == SpeedLimitStatus::UNKNOWN && rawLimit != 0) {
    return DecodeError::SPEED_LIMIT_INVALID;
  }
  if (slStatus != SpeedLimitStatus::UNKNOWN && rawLimit == 0) {
    return DecodeError::SPEED_LIMIT_INVALID;
  }

  const uint32_t rawTurnDist = read_u32_le(bytes + 16);
  if (rawTurnDist != U32_UNKNOWN && rawTurnDist > MAX_TURN_DISTANCE_M) {
    return DecodeError::DISTANCE_OUT_OF_RANGE;
  }

  const uint32_t rawRemDist = read_u32_le(bytes + 20);
  if (rawRemDist != U32_UNKNOWN && rawRemDist > MAX_REMAINING_DISTANCE_M) {
    return DecodeError::DISTANCE_OUT_OF_RANGE;
  }

  const uint16_t rawHeading = read_u16_le(bytes + 26);
  if (rawHeading != U16_UNKNOWN && rawHeading >= 3600) {
    return DecodeError::HEADING_OUT_OF_RANGE;
  }

  const int32_t latE6 = read_i32_le(bytes + 28);
  const int32_t lonE6 = read_i32_le(bytes + 32);
  if ((latE6 == I32_UNKNOWN) != (lonE6 == I32_UNKNOWN)) {
    return DecodeError::COORDINATE_OUT_OF_RANGE;
  }
  if (latE6 != I32_UNKNOWN) {
    if (latE6 < -90000000L || latE6 > 90000000L || lonE6 < -180000000L || lonE6 > 180000000L) {
      return DecodeError::COORDINATE_OUT_OF_RANGE;
    }
  }

  out.version = version;
  out.msgType = msgType;
  out.sessionId = sessionId;
  out.sequenceNumber = read_u16_le(bytes + 4);
  out.timestampMs = read_u32_le(bytes + 6);
  out.gpsActive = (flags & (1 << 0)) != 0;
  out.routeActive = (flags & (1 << 1)) != 0;
  out.speedLimitStatus = slStatus;
  out.isOffRoute = (flags & (1 << 4)) != 0;
  out.hasArrived = (flags & (1 << 5)) != 0;
  out.turnDirection = static_cast<TurnDirection>(turnIdx);
  out.currentSpeedKmh = rawSpeed;
  out.speedLimitKmh = rawLimit;
  out.gpsAccuracyMeters = bytes[15];
  out.distanceToTurnMeters = rawTurnDist;
  out.remainingDistanceMeters = rawRemDist;
  out.etaDurationMinutes = read_u16_le(bytes + 24);
  out.headingDeciDeg = rawHeading;
  out.latitudeE6 = latE6;
  out.longitudeE6 = lonE6;
  return DecodeError::OK;
}

inline void encode_device_status(
    uint8_t out[DEVICE_STATUS_FRAME_BYTES],
    uint16_t lastSessionId,
    uint16_t lastAcceptedSeq,
    uint32_t lastPhoneTimestampMs,
    uint32_t deviceUptimeMs) {
  out[0] = PROTOCOL_VERSION;
  out[1] = MSG_TYPE_DEVICE_STATUS;
  write_u16_le(out + 2, lastSessionId);
  write_u16_le(out + 4, lastAcceptedSeq);
  write_u32_le(out + 6, lastPhoneTimestampMs);
  write_u32_le(out + 10, deviceUptimeMs);
  write_u16_le(out + 14, crc16_ccitt(out, 14));
}

struct ReceiverState {
  bool bleConnected = false;
  bool hasValidFrame = false;
  bool hasSeqInSession = false;
  uint16_t activeSessionId = 0;
  uint16_t lastSequenceNumber = 0;
  uint32_t lastFrameReceivedAtMs = 0;
  TelemetryFrame latestFrame{};
  uint32_t acceptedFrames = 0;
  uint32_t rejectedFrames = 0;
  uint32_t duplicateOrOldFrames = 0;
  uint32_t sessionResets = 0;
  DecodeError lastError = DecodeError::OK;

  void onConnect() {
    bleConnected = true;
  }

  void onDisconnect() {
    bleConnected = false;
    hasSeqInSession = false;
    activeSessionId = 0;
    lastSequenceNumber = 0;
  }

  DecodeError receiveBytes(const uint8_t* bytes, size_t len, uint32_t nowMs) {
    bleConnected = true;
    TelemetryFrame candidate{};
    const DecodeError err = decode_telemetry(bytes, len, candidate);
    if (err != DecodeError::OK) {
      rejectedFrames++;
      lastError = err;
      return err;
    }

    if (activeSessionId == 0) {
      activeSessionId = candidate.sessionId;
      hasSeqInSession = false;
    } else if (candidate.sessionId != activeSessionId) {
      activeSessionId = candidate.sessionId;
      hasSeqInSession = false;
      sessionResets++;
    }

    if (hasSeqInSession && candidate.sequenceNumber <= lastSequenceNumber) {
      duplicateOrOldFrames++;
      lastError = DecodeError::DUPLICATE_OR_OLD_SEQ;
      return DecodeError::DUPLICATE_OR_OLD_SEQ;
    }

    hasSeqInSession = true;
    lastSequenceNumber = candidate.sequenceNumber;
    lastFrameReceivedAtMs = nowMs;
    latestFrame = candidate;
    hasValidFrame = true;
    acceptedFrames++;
    lastError = DecodeError::OK;
    return DecodeError::OK;
  }

  bool isStale(uint32_t nowMs, uint32_t maxAgeMs = 3000U) const {
    if (!hasValidFrame) return true;
    return (nowMs - lastFrameReceivedAtMs) > maxAgeMs;
  }

  DisplayBannerState evaluateBannerState(uint32_t nowMs, uint32_t maxAgeMs = 3000U, uint16_t thresholdKmh = 5) const {
    if (!bleConnected) return DisplayBannerState::DISCONNECTED;
    if (!hasValidFrame || !latestFrame.gpsActive) return DisplayBannerState::GPS_LOST;
    if (isStale(nowMs, maxAgeMs)) return DisplayBannerState::DATA_STALE;
    if (latestFrame.currentSpeedKmh == U16_UNKNOWN) return DisplayBannerState::NO_SPEED;
    if (latestFrame.speedLimitStatus == SpeedLimitStatus::UNKNOWN || latestFrame.speedLimitKmh == 0) {
      return DisplayBannerState::UNKNOWN_LIMIT;
    }
    if (latestFrame.speedLimitStatus == SpeedLimitStatus::STALE) {
      return DisplayBannerState::STALE_LIMIT;
    }
    if (latestFrame.currentSpeedKmh > static_cast<uint16_t>(latestFrame.speedLimitKmh + thresholdKmh)) {
      return DisplayBannerState::WARNING;
    }
    return DisplayBannerState::NORMAL;
  }
};

} // namespace wmap
