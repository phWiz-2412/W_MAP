#if canImport(CoreLocation) && canImport(CoreBluetooth)
import Foundation
import CoreLocation
import CoreBluetooth
import WMapCore

/**
 * Native iOS CoreLocation + CoreBluetooth Central coordinator for W_MAP.
 * - Uses `kCLLocationAccuracyBestForNavigation` and `activityType = .automotiveNavigation`.
 * - Prioritizes trustworthy platform `CLLocation.speed` (>= 0) over coordinate differentiation.
 * - Scans for the ESP32-S3 GATT service (`7f3a0000-0000-4d41-5057-4d4150000001`), negotiates MTU,
 *   and transmits 38-byte binary telemetry frames using a latest-state coalescing policy.
 */
@MainActor
public final class WMapPhoneCoordinator: NSObject, ObservableObject {
    @Published public private(set) var bleConnected: Bool = false
    @Published public private(set) var gpsActive: Bool = false
    @Published public private(set) var currentSpeedKmh: UInt16? = nil
    @Published public private(set) var lastCoordinate: RoutePoint? = nil
    @Published public private(set) var lastError: String? = nil

    private let locationManager = CLLocationManager()
    private var centralManager: CBCentralManager!
    private var connectedPeripheral: CBPeripheral?
    private var telemetryCharacteristic: CBCharacteristic?

    private let sessionId: UInt16 = UInt16.random(in: 1...UInt16.max)
    private var sequenceNumber: UInt16 = 0
    private var lastSentAtMs: UInt64 = 0

    public override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.activityType = .automotiveNavigation
        locationManager.distanceFilter = 2.0
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    public func startNavigationSession() {
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
        locationManager.startUpdatingHeading()
        startBleScanIfNeeded()
    }

    public func stopNavigationSession() {
        locationManager.stopUpdatingLocation()
        locationManager.stopUpdatingHeading()
        if let p = connectedPeripheral {
            centralManager.cancelPeripheralConnection(p)
        }
    }

    private func startBleScanIfNeeded() {
        guard centralManager.state == .poweredOn, connectedPeripheral == nil else { return }
        let serviceUUID = CBUUID(string: BleProtocolCodec.serviceUUIDString)
        centralManager.scanForPeripherals(withServices: [serviceUUID], options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false
        ])
    }
}

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
            self.lastCoordinate = RoutePoint(
                latitude: latest.coordinate.latitude,
                longitude: latest.coordinate.longitude
            )
            if latest.speed >= 0 {
                let kmh = min(300.0, max(0.0, (latest.speed * 3.6).rounded()))
                self.currentSpeedKmh = UInt16(kmh)
            } else {
                self.currentSpeedKmh = nil
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

extension WMapPhoneCoordinator: CBCentralManagerDelegate, CBPeripheralDelegate {
    nonisolated public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            if central.state == .poweredOn {
                self.startBleScanIfNeeded()
            } else {
                self.bleConnected = false
            }
        }
    }

    nonisolated public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        Task { @MainActor in
            self.centralManager.stopScan()
            self.connectedPeripheral = peripheral
            peripheral.delegate = self
            self.centralManager.connect(peripheral, options: nil)
        }
    }

    nonisolated public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            self.bleConnected = true
            peripheral.discoverServices([CBUUID(string: BleProtocolCodec.serviceUUIDString)])
        }
    }

    nonisolated public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        Task { @MainActor in
            self.bleConnected = false
            self.connectedPeripheral = nil
            self.telemetryCharacteristic = nil
            self.startBleScanIfNeeded()
        }
    }
}
#endif
