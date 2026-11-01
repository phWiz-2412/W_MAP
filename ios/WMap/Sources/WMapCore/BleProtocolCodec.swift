import Foundation

public enum BleProtocolError: Error, Equatable {
    case invalidSessionId
    case invalidSpeedLimitCombination
    case speedOutOfRange
    case distanceOutOfRange
    case headingOutOfRange
    case coordinateOutOfRange
    case invalidLength
    case crcMismatch
    case unsupportedVersion
    case invalidMessageType
}

public enum BleProtocolCodec {
    public static let serviceUUIDString = "7f3a0000-0000-4d41-5057-4d4150000001"
    public static let telemetryCharUUIDString = "7f3a0001-0000-4d41-5057-4d4150000001"
    public static let routeChunkCharUUIDString = "7f3a0002-0000-4d41-5057-4d4150000001"
    public static let deviceStatusCharUUIDString = "7f3a0003-0000-4d41-5057-4d4150000001"

    public static func crc16Ccitt(_ bytes: [UInt8], count: Int) -> UInt16 {
        var crc: UInt16 = 0xFFFF
        for i in 0..<count {
            crc ^= UInt16(bytes[i]) << 8
            for _ in 0..<8 {
                if (crc & 0x8000) != 0 {
                    crc = (crc &<< 1) ^ 0x1021
                } else {
                    crc = crc &<< 1
                }
            }
        }
        return crc
    }

    public static func encodeTelemetry(_ frame: BleTelemetryFrame) throws -> Data {
        guard frame.sessionId >= 1 else { throw BleProtocolError.invalidSessionId }
        if frame.speedLimitStatus == .unknown && frame.speedLimitKmh != nil {
            throw BleProtocolError.invalidSpeedLimitCombination
        }
        if frame.speedLimitStatus != .unknown && (frame.speedLimitKmh == nil || frame.speedLimitKmh! == 0 || frame.speedLimitKmh! > 200) {
            throw BleProtocolError.invalidSpeedLimitCombination
        }

        var bytes = [UInt8](repeating: 0, count: BleTelemetryFrame.frameByteCount)
        bytes[0] = frame.version
        bytes[1] = frame.msgType
        writeU16LE(&bytes, offset: 2, value: frame.sessionId)
        writeU16LE(&bytes, offset: 4, value: frame.sequenceNumber)
        writeU32LE(&bytes, offset: 6, value: frame.timestampMs)

        var flags: UInt8 = 0
        if frame.gpsActive { flags |= 1 << 0 }
        if frame.routeActive { flags |= 1 << 1 }
        flags |= (frame.speedLimitStatus.rawValue & 0x03) << 2
        if frame.isOffRoute { flags |= 1 << 4 }
        if frame.hasArrived { flags |= 1 << 5 }
        bytes[10] = flags
        bytes[11] = frame.turnDirection.rawValue

        if let spd = frame.currentSpeedKmh {
            guard spd <= 300 else { throw BleProtocolError.speedOutOfRange }
            writeU16LE(&bytes, offset: 12, value: spd)
        } else {
            writeU16LE(&bytes, offset: 12, value: 0xFFFF)
        }

        bytes[14] = frame.speedLimitKmh ?? 0
        bytes[15] = frame.gpsAccuracyMeters.map { min(254, $0) } ?? 0xFF

        if let dist = frame.distanceToTurnMeters {
            guard dist <= 100_000 else { throw BleProtocolError.distanceOutOfRange }
            writeU32LE(&bytes, offset: 16, value: dist)
        } else {
            writeU32LE(&bytes, offset: 16, value: 0xFFFFFFFF)
        }

        if let rem = frame.remainingDistanceMeters {
            guard rem <= 1_000_000 else { throw BleProtocolError.distanceOutOfRange }
            writeU32LE(&bytes, offset: 20, value: rem)
        } else {
            writeU32LE(&bytes, offset: 20, value: 0xFFFFFFFF)
        }

        writeU16LE(&bytes, offset: 24, value: frame.etaDurationMinutes.map { min(65534, $0) } ?? 0xFFFF)

        if let hdg = frame.headingDegrees {
            guard hdg.isFinite && hdg >= 0.0 && hdg < 360.0 else { throw BleProtocolError.headingOutOfRange }
            let deci = UInt16(Int((hdg * 10.0).rounded()) % 3600)
            writeU16LE(&bytes, offset: 26, value: deci)
        } else {
            writeU16LE(&bytes, offset: 26, value: 0xFFFF)
        }

        if let lat = frame.latitude, let lon = frame.longitude {
            guard RoutePoint(latitude: lat, longitude: lon).isValid else {
                throw BleProtocolError.coordinateOutOfRange
            }
            writeI32LE(&bytes, offset: 28, value: Int32((lat * 1_000_000.0).rounded()))
            writeI32LE(&bytes, offset: 32, value: Int32((lon * 1_000_000.0).rounded()))
        } else if frame.latitude == nil && frame.longitude == nil {
            writeI32LE(&bytes, offset: 28, value: Int32.min)
            writeI32LE(&bytes, offset: 32, value: Int32.min)
        } else {
            throw BleProtocolError.coordinateOutOfRange
        }

        let crc = crc16Ccitt(bytes, count: 36)
        writeU16LE(&bytes, offset: 36, value: crc)
        return Data(bytes)
    }

    private static func writeU16LE(_ buf: inout [UInt8], offset: Int, value: UInt16) {
        buf[offset] = UInt8(value & 0xFF)
        buf[offset + 1] = UInt8((value >> 8) & 0xFF)
    }

    private static func writeU32LE(_ buf: inout [UInt8], offset: Int, value: UInt32) {
        buf[offset] = UInt8(value & 0xFF)
        buf[offset + 1] = UInt8((value >> 8) & 0xFF)
        buf[offset + 2] = UInt8((value >> 16) & 0xFF)
        buf[offset + 3] = UInt8((value >> 24) & 0xFF)
    }

    private static func writeI32LE(_ buf: inout [UInt8], offset: Int, value: Int32) {
        writeU32LE(&buf, offset: offset, value: UInt32(bitPattern: value))
    }
}
