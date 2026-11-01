import XCTest
@testable import WMapCore

final class BleProtocolTests: XCTestCase {
    func testGoldenVector0ActiveNavigationInDaNang() throws {
        let frame = BleTelemetryFrame(
            sessionId: 0x1024,
            sequenceNumber: 7,
            timestampMs: 125_000,
            gpsActive: true,
            routeActive: true,
            speedLimitStatus: .unknown,
            isOffRoute: false,
            hasArrived: false,
            turnDirection: .right,
            currentSpeedKmh: 45,
            speedLimitKmh: nil,
            gpsAccuracyMeters: 6,
            distanceToTurnMeters: 180,
            remainingDistanceMeters: 8450,
            etaDurationMinutes: 14,
            headingDegrees: 92.5,
            latitude: 16.0611,
            longitude: 108.2272
        )

        let data = try BleProtocolCodec.encodeTelemetry(frame)
        let hex = data.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, "01012410070048e8010003012d000006b4000000022100000e009d03ac12f500806a7306650d")
    }

    func testGoldenVector1GpsLostAndRouteInactive() throws {
        let frame = BleTelemetryFrame(
            sessionId: 0x1024,
            sequenceNumber: 8,
            timestampMs: 126_000,
            gpsActive: false,
            routeActive: false,
            speedLimitStatus: .unknown,
            isOffRoute: false,
            hasArrived: false,
            turnDirection: .straight,
            currentSpeedKmh: nil,
            speedLimitKmh: nil,
            gpsAccuracyMeters: nil,
            distanceToTurnMeters: nil,
            remainingDistanceMeters: nil,
            etaDurationMinutes: nil,
            headingDegrees: nil,
            latitude: nil,
            longitude: nil
        )

        let data = try BleProtocolCodec.encodeTelemetry(frame)
        let hex = data.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, "01012410080030ec01000002ffff00ffffffffffffffffffffffffff0000008000000080ba0a")
    }
}
