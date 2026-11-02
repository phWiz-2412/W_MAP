#if canImport(CoreLocation) && canImport(CoreBluetooth)
import Foundation
import CoreLocation
import CoreBluetooth
import WMapCore

/// Visible BLE link state so the UI never reports "connected" before the GATT pipe is usable.
public enum WMapBleLinkState: String, Sendable, Equatable {
    case bluetoothOff
    case unauthorized
    case scanning
    case connecting
    case discoveringServices
    /// Characteristic discovered; telemetry writes are possible. This is the only "ready" state.
    case ready
    case disconnected
}

/// Navigation fields supplied by the route engine; merged with live GPS into each BLE frame.
public struct WMapNavigationSnapshot: Sendable, Equatable {
    public var routeActive = false
    public var turnDirection: TurnDirection = .straight
    public var distanceToTurnMeters: UInt32? = nil
    public var remainingDistanceMeters: UInt32? = nil
    public var etaDurationMinutes: UInt16? = nil
    public var speedLimitKmh: UInt8? = nil
    public var isOffRoute = false
    public var hasArrived = false
    public init() {}
}

/**
 * Native iOS CoreLocation + CoreBluetooth Central coordinator for W_MAP.
 *
 * Link design (no shared WiFi / no router):
 * - Scans for the W_MAP GATT service, connects, discovers the telemetry characteristic, and only then
 *   reports `.ready`.
 * - Uses a *pending* `connect` so iOS reconnects automatically when the ESP32 powers up (bike started),
 *   and state restoration so the app is relaunched in background for BLE events.
 * - Sends a frame every `sendIntervalSeconds` (heartbeat) even if GPS did not change, so the display can
 *   tell "fresh but stationary" from "phone silent". GPS loss is sent as `gpsActive = false`, never as stale data.
 * - Uses write-without-response with flow control (`canSendWriteWithoutResponse` / `peripheralIsReady`);
 *   only the newest state is ever kept (latest-state coalescing, no backlog = no growing latency).
 */
@MainActor
public final class WMapPhoneCoordinator: NSObject, ObservableObject {
    @Published public private(set) var linkState: WMapBleLinkState = .disconnected
    @Published public private(set) var bleReady: Bool = false
    @Published public private(set) var gpsActive: Bool = false
    @Published public private(set) var currentSpeedKmh: UInt16? = nil
    @Published public private(set) var lastCoordinate: RoutePoint? = nil
    @Published public private(set) var headingDegrees: Double? = nil
    @Published public private(set) var framesSent: Int = 0
    @Published public private(set) var lastDeviceAckSequence: UInt16? = nil
    @Published public private(set) var lastError: String? = nil

    public var navigation = WMapNavigationSnapshot()

    private static let restoreIdentifier = "com.wmap.central"
    private static let savedPeripheralKey = "wmap.lastPeripheralUUID"
    private let sendIntervalSeconds: TimeInterval = 0.2

    private let locationManager = CLLocationManager()
    private var centralManager: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var telemetryCharacteristic: CBCharacteristic?
    private var statusCharacteristic: CBCharacteristic?

    private let sessionId: UInt16 = UInt16.random(in: 1...UInt16.max)
    private var sequenceNumber: UInt16 = 0
    private var sendTimer: Timer?
    private var pendingFrame: Data?
    private var lastFixAt: Date?
    private var lastAccuracy: UInt8?

    public override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.activityType = .automotiveNavigation
        locationManager.distanceFilter = kCLDistanceFilterNone
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.headingFilter = 2
        centralManager = CBCentralManager(
            delegate: self,
            queue: nil,
            options: [CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier]
        )
    }

    public func startNavigationSession() {
        locationManager.requestWhenInUseAuthorization()
        locationManager.requestAlwaysAuthorization()
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.showsBackgroundLocationIndicator = true
        locationManager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { locationManager.startUpdatingHeading() }
        connectOrScan()
        startSendTimer()
    }

    public func stopNavigationSession() {
        sendTimer?.invalidate()
        sendTimer = nil
        locationManager.stopUpdatingLocation()
        locationManager.stopUpdatingHeading()
        if let p = peripheral { centralManager.cancelPeripheralConnection(p) }
        centralManager.stopScan()
        peripheral = nil
        telemetryCharacteristic = nil
        updateLink(.disconnected)
    }

    // MARK: - Connection

    private func connectOrScan() {
        guard centralManager.state == .poweredOn else { return }
        // Fast path: reconnect to the display we used before. connect() never times out, so iOS will
        // connect as soon as the ESP32 starts advertising, even from the background.
        if let idString = UserDefaults.standard.string(forKey: Self.savedPeripheralKey),
           let uuid = UUID(uuidString: idString),
           let known = centralManager.retrievePeripherals(withIdentifiers: [uuid]).first {
            adopt(known)
            return
        }
        let serviceUUID = CBUUID(string: BleProtocolCodec.serviceUUIDString)
        // Display may already be connected to the system (e.g. after app relaunch).
        if let connected = centralManager.retrieveConnectedPeripherals(withServices: [serviceUUID]).first {
            adopt(connected)
            return
        }
        updateLink(.scanning)
        centralManager.scanForPeripherals(withServices: [serviceUUID], options: nil)
    }

    private func adopt(_ p: CBPeripheral) {
        centralManager.stopScan()
        peripheral = p
        p.delegate = self
        if p.state == .connected {
            updateLink(.discoveringServices)
            p.discoverServices([CBUUID(string: BleProtocolCodec.serviceUUIDString)])
        } else {
            updateLink(.connecting)
            centralManager.connect(p, options: nil)
        }
    }

    private func updateLink(_ s: WMapBleLinkState) {
        linkState = s
        bleReady = (s == .ready)
    }

    // MARK: - Telemetry transmission (latest-state coalescing)

    private func startSendTimer() {
        sendTimer?.invalidate()
        sendTimer = Timer.scheduledTimer(withTimeInterval: sendIntervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.buildAndSend() }
        }
    }

    private func buildAndSend() {
        let fixFresh = lastFixAt.map { Date().timeIntervalSince($0) <= 3.0 } ?? false
        let active = gpsActive && fixFresh
        if gpsActive && !fixFresh { gpsActive = false; currentSpeedKmh = nil }

        sequenceNumber &+= 1
        let uptimeMs = UInt32(truncatingIfNeeded: UInt64(ProcessInfo.processInfo.systemUptime * 1000))
        let frame = BleTelemetryFrame(
            sessionId: sessionId,
            sequenceNumber: sequenceNumber,
            timestampMs: uptimeMs,
            gpsActive: active,
            routeActive: navigation.routeActive,
            speedLimitStatus: navigation.speedLimitKmh == nil ? .unknown : .valid,
            isOffRoute: navigation.isOffRoute,
            hasArrived: navigation.hasArrived,
            turnDirection: navigation.turnDirection,
            currentSpeedKmh: active ? currentSpeedKmh : nil,
            speedLimitKmh: navigation.speedLimitKmh,
            gpsAccuracyMeters: active ? lastAccuracy : nil,
            distanceToTurnMeters: navigation.distanceToTurnMeters,
            remainingDistanceMeters: navigation.remainingDistanceMeters,
            etaDurationMinutes: navigation.etaDurationMinutes,
            headingDegrees: headingDegrees,
            latitude: active ? lastCoordinate?.latitude : nil,
            longitude: active ? lastCoordinate?.longitude : nil
        )
        do {
            pendingFrame = try BleProtocolCodec.encodeTelemetry(frame)
        } catch {
            lastError = "Telemetry encode failed: \(error)"
            return
        }
        flushPending()
    }

    private func flushPending() {
        guard bleReady,
              let p = peripheral,
              let ch = telemetryCharacteristic,
              let data = pendingFrame else { return }
        // Flow control: if the BLE queue is full keep only the newest frame and wait for peripheralIsReady.
        guard p.canSendWriteWithoutResponse else { return }
        p.writeValue(data, for: ch, type: .withoutResponse)
        pendingFrame = nil
        framesSent += 1
    }
}

// MARK: - CoreLocation

extension WMapPhoneCoordinator: CLLocationManagerDelegate {
    nonisolated public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor in
            let ageSeconds = abs(latest.timestamp.timeIntervalSinceNow)
            guard latest.horizontalAccuracy >= 0, latest.horizontalAccuracy <= 100.0, ageSeconds <= 3.0 else {
                self.gpsActive = false
                self.currentSpeedKmh = nil
                return
            }
            self.gpsActive = true
            self.lastFixAt = Date()
            self.lastAccuracy = UInt8(min(254.0, latest.horizontalAccuracy.rounded()))
            self.lastCoordinate = RoutePoint(
                latitude: latest.coordinate.latitude,
                longitude: latest.coordinate.longitude
            )
            if latest.speed >= 0 {
                self.currentSpeedKmh = UInt16(min(300.0, max(0.0, (latest.speed * 3.6).rounded())))
            } else {
                self.currentSpeedKmh = nil
            }
            // GPS course-over-ground is only trustworthy while moving; otherwise the compass heading is kept.
            if latest.course >= 0, latest.speed >= 3.0 {
                self.headingDegrees = latest.course
            }
        }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard newHeading.headingAccuracy >= 0 else { return }
        let h = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        Task { @MainActor in
            // Magnetometer heading is used when stationary / slow.
            if (self.currentSpeedKmh ?? 0) < 11 {
                self.headingDegrees = h.truncatingRemainder(dividingBy: 360.0)
            }
        }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.gpsActive = false
            self.lastError = error.localizedDescription
        }
    }
}

// MARK: - CoreBluetooth

extension WMapPhoneCoordinator: CBCentralManagerDelegate, CBPeripheralDelegate {
    nonisolated public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            switch central.state {
            case .poweredOn:
                if self.peripheral == nil { self.connectOrScan() }
            case .unauthorized:
                self.updateLink(.unauthorized)
                self.lastError = "Bluetooth permission denied. Enable it in Settings > W_MAP."
            default:
                self.updateLink(.bluetoothOff)
            }
        }
    }

    nonisolated public func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first
        Task { @MainActor in
            if let p = restored { self.adopt(p) }
        }
    }

    nonisolated public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        Task { @MainActor in self.adopt(peripheral) }
    }

    nonisolated public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: Self.savedPeripheralKey)
            self.updateLink(.discoveringServices)
            peripheral.discoverServices([CBUUID(string: BleProtocolCodec.serviceUUIDString)])
        }
    }

    nonisolated public func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        Task { @MainActor in
            self.lastError = error?.localizedDescription
            self.updateLink(.connecting)
            self.centralManager.connect(peripheral, options: nil) // pending connect: retries until it succeeds
        }
    }

    nonisolated public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        Task { @MainActor in
            self.telemetryCharacteristic = nil
            self.statusCharacteristic = nil
            self.pendingFrame = nil
            self.updateLink(.disconnected)
            // Re-arm immediately; iOS completes the connection as soon as the display is back in range / powered.
            guard self.sendTimer != nil else { return }
            self.updateLink(.connecting)
            self.centralManager.connect(peripheral, options: nil)
        }
    }

    nonisolated public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let svc = peripheral.services?.first(where: {
            $0.uuid == CBUUID(string: BleProtocolCodec.serviceUUIDString)
        }) else {
            Task { @MainActor in self.lastError = "W_MAP service not found on device." }
            return
        }
        peripheral.discoverCharacteristics([
            CBUUID(string: BleProtocolCodec.telemetryCharUUIDString),
            CBUUID(string: BleProtocolCodec.deviceStatusCharUUIDString),
        ], for: svc)
    }

    nonisolated public func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard error == nil else { return }
        let telemetry = service.characteristics?.first { $0.uuid == CBUUID(string: BleProtocolCodec.telemetryCharUUIDString) }
        let status = service.characteristics?.first { $0.uuid == CBUUID(string: BleProtocolCodec.deviceStatusCharUUIDString) }
        if let status { peripheral.setNotifyValue(true, for: status) }
        Task { @MainActor in
            self.statusCharacteristic = status
            guard let telemetry else {
                self.lastError = "Telemetry characteristic missing on device."
                return
            }
            self.telemetryCharacteristic = telemetry
            self.updateLink(.ready) // the only place "ready" is declared
        }
    }

    nonisolated public func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        Task { @MainActor in self.flushPending() }
    }

    /// Device status notifications (16 bytes) prove the ESP32 actually received frames (end-to-end ack).
    nonisolated public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard characteristic.uuid == CBUUID(string: BleProtocolCodec.deviceStatusCharUUIDString),
              let d = characteristic.value, d.count == 16, d[0] == 1, d[1] == 0x03 else { return }
        let bytes = [UInt8](d)
        let crc = UInt16(bytes[14]) | (UInt16(bytes[15]) << 8)
        guard BleProtocolCodec.crc16Ccitt(bytes, count: 14) == crc else { return }
        // Layout: [0]=ver [1]=type [2..3]=session [4..5]=lastAcceptedSequence
        let ack = UInt16(bytes[4]) | (UInt16(bytes[5]) << 8)
        Task { @MainActor in self.lastDeviceAckSequence = ack }
    }
}
#endif
