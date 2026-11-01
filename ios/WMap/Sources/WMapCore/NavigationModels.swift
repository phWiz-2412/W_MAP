import Foundation

public enum TurnDirection: UInt8, CaseIterable, Sendable, Equatable {
    case left = 0
    case right = 1
    case straight = 2
    case uTurn = 3
    case roundabout = 4
}

public enum SpeedLimitStatus: UInt8, Sendable, Equatable {
    case unknown = 0
    case valid = 1
    case stale = 2
}

public enum RouteTravelMode: String, Sendable, Equatable {
    case twoWheeler = "TWO_WHEELER"
    case drive = "DRIVE"
}

public struct RoutePreferences: Sendable, Equatable {
    public var travelMode: RouteTravelMode
    public var avoidHighways: Bool
    public var avoidTolls: Bool
    public var avoidFerries: Bool

    public init(
        travelMode: RouteTravelMode = .twoWheeler,
        avoidHighways: Bool = true,
        avoidTolls: Bool = false,
        avoidFerries: Bool = false
    ) {
        self.travelMode = travelMode
        self.avoidHighways = avoidHighways
        self.avoidTolls = avoidTolls
        self.avoidFerries = avoidFerries
    }
}

public struct RoutePoint: Sendable, Equatable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    public var isValid: Bool {
        latitude.isFinite && longitude.isFinite &&
        latitude >= -90.0 && latitude <= 90.0 &&
        longitude >= -180.0 && longitude <= 180.0
    }
}

public struct BleTelemetryFrame: Sendable, Equatable {
    public static let protocolVersion: UInt8 = 1
    public static let msgTypeTelemetry: UInt8 = 0x01
    public static let frameByteCount: Int = 38

    public var version: UInt8 = BleTelemetryFrame.protocolVersion
    public var msgType: UInt8 = BleTelemetryFrame.msgTypeTelemetry
    public var sessionId: UInt16
    public var sequenceNumber: UInt16
    public var timestampMs: UInt32
    public var gpsActive: Bool
    public var routeActive: Bool
    public var speedLimitStatus: SpeedLimitStatus
    public var isOffRoute: Bool
    public var hasArrived: Bool
    public var turnDirection: TurnDirection
    public var currentSpeedKmh: UInt16?
    public var speedLimitKmh: UInt8?
    public var gpsAccuracyMeters: UInt8?
    public var distanceToTurnMeters: UInt32?
    public var remainingDistanceMeters: UInt32?
    public var etaDurationMinutes: UInt16?
    public var headingDegrees: Double?
    public var latitude: Double?
    public var longitude: Double?

    public init(
        sessionId: UInt16,
        sequenceNumber: UInt16,
        timestampMs: UInt32,
        gpsActive: Bool,
        routeActive: Bool,
        speedLimitStatus: SpeedLimitStatus,
        isOffRoute: Bool,
        hasArrived: Bool,
        turnDirection: TurnDirection,
        currentSpeedKmh: UInt16?,
        speedLimitKmh: UInt8?,
        gpsAccuracyMeters: UInt8?,
        distanceToTurnMeters: UInt32?,
        remainingDistanceMeters: UInt32?,
        etaDurationMinutes: UInt16?,
        headingDegrees: Double?,
        latitude: Double?,
        longitude: Double?
    ) {
        self.sessionId = sessionId
        self.sequenceNumber = sequenceNumber
        self.timestampMs = timestampMs
        self.gpsActive = gpsActive
        self.routeActive = routeActive
        self.speedLimitStatus = speedLimitStatus
        self.isOffRoute = isOffRoute
        self.hasArrived = hasArrived
        self.turnDirection = turnDirection
        self.currentSpeedKmh = currentSpeedKmh
        self.speedLimitKmh = speedLimitKmh
        self.gpsAccuracyMeters = gpsAccuracyMeters
        self.distanceToTurnMeters = distanceToTurnMeters
        self.remainingDistanceMeters = remainingDistanceMeters
        self.etaDurationMinutes = etaDurationMinutes
        self.headingDegrees = headingDegrees
        self.latitude = latitude
        self.longitude = longitude
    }
}
