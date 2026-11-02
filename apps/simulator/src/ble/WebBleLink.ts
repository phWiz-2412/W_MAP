import {
  WMAP_BLE_DEVICE_STATUS_CHAR_UUID,
  WMAP_BLE_SERVICE_UUID,
  WMAP_BLE_TELEMETRY_CHAR_UUID,
  decodeBleDeviceStatus,
  encodeBleTelemetryFrame,
  type BleTelemetryFrame,
} from "@w-map/navigation-core";

/**
 * Minimal Web Bluetooth surface so the link can be unit-tested without hardware.
 * NOTE: Web Bluetooth works in Chrome/Edge on Windows/Android/macOS. iPhone Safari does NOT support it,
 * so on iPhone the real BLE link is the native app in `ios/WMap`. This class lets a PC act as the "phone"
 * to validate the ESP32-S3 firmware and the binary protocol over real Bluetooth.
 */
export interface GattCharacteristicLike {
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications?(): Promise<unknown>;
  addEventListener?(type: "characteristicvaluechanged", cb: (ev: { target: { value?: DataView } }) => void): void;
}
export interface GattServiceLike {
  getCharacteristic(uuid: string): Promise<GattCharacteristicLike>;
}
export interface GattServerLike {
  connected: boolean;
  getPrimaryService(uuid: string): Promise<GattServiceLike>;
  disconnect(): void;
}
export interface BluetoothDeviceLike {
  name?: string;
  gatt?: { connect(): Promise<GattServerLike> };
  addEventListener?(type: "gattserverdisconnected", cb: () => void): void;
}
export interface BluetoothLike {
  requestDevice(options: unknown): Promise<BluetoothDeviceLike>;
}

export type BleLinkState = "idle" | "requesting" | "connecting" | "ready" | "reconnecting" | "failed";

export interface BleLinkSnapshot {
  state: BleLinkState;
  deviceName: string | null;
  framesSent: number;
  framesDropped: number;
  /** Highest sequence number the ESP32 reports it accepted (end-to-end proof of delivery). */
  deviceAckSequence: number | null;
  lastSentSequence: number | null;
  /** Frames sent but not yet acknowledged by the device. */
  unackedFrames: number | null;
  lastError: string | null;
}

export interface WebBleLinkOptions {
  bluetooth?: BluetoothLike | null;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  onChange?: (s: BleLinkSnapshot) => void;
}

/**
 * Only the newest frame is ever pending (latest-state coalescing): a slow radio can never build a backlog
 * and therefore never adds growing latency.
 */
export class WebBleLink {
  private device: BluetoothDeviceLike | null = null;
  private server: GattServerLike | null = null;
  private telemetry: GattCharacteristicLike | null = null;
  private state: BleLinkState = "idle";
  private framesSent = 0;
  private framesDropped = 0;
  private deviceAck: number | null = null;
  private lastSeq: number | null = null;
  private lastError: string | null = null;
  private writing = false;
  private pending: Uint8Array | null = null;
  private reconnectAttempts = 0;
  private userStopped = false;

  private readonly bluetooth: BluetoothLike | null;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly onChange: ((s: BleLinkSnapshot) => void) | undefined;

  constructor(opts: WebBleLinkOptions = {}) {
    this.bluetooth =
      opts.bluetooth !== undefined
        ? opts.bluetooth
        : typeof navigator !== "undefined" && "bluetooth" in navigator
          ? (navigator as unknown as { bluetooth: BluetoothLike }).bluetooth
          : null;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 20;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.onChange = opts.onChange;
  }

  get isSupported(): boolean {
    return this.bluetooth !== null;
  }

  getSnapshot(): BleLinkSnapshot {
    return {
      state: this.state,
      deviceName: this.device?.name ?? null,
      framesSent: this.framesSent,
      framesDropped: this.framesDropped,
      deviceAckSequence: this.deviceAck,
      lastSentSequence: this.lastSeq,
      unackedFrames:
        this.deviceAck === null || this.lastSeq === null ? null : (this.lastSeq - this.deviceAck + 65536) % 65536,
      lastError: this.lastError,
    };
  }

  /** Must be called from a user gesture (browser requirement). */
  async connect(): Promise<void> {
    if (!this.bluetooth) {
      this.fail("Web Bluetooth is not supported here. Use Chrome/Edge on PC/Android (iPhone Safari cannot).");
      return;
    }
    this.userStopped = false;
    this.reconnectAttempts = 0;
    this.setState("requesting");
    try {
      this.device = await this.bluetooth.requestDevice({
        filters: [{ services: [WMAP_BLE_SERVICE_UUID] }],
      });
      this.device.addEventListener?.("gattserverdisconnected", () => this.onDisconnected());
      await this.openGatt();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Bluetooth device selection failed.");
    }
  }

  disconnect(): void {
    this.userStopped = true;
    this.pending = null;
    this.telemetry = null;
    if (this.server?.connected) this.server.disconnect();
    this.setState("idle");
  }

  /**
   * Sends the newest frame. Returns false if the link is not READY (nothing is sent and nothing is faked).
   */
  async sendTelemetry(frame: BleTelemetryFrame): Promise<boolean> {
    if (this.state !== "ready" || !this.telemetry) return false;
    this.pending = encodeBleTelemetryFrame(frame);
    this.lastSeq = frame.sequenceNumber;
    if (this.writing) {
      // A write is in flight: the older pending frame (if any) was replaced by this newer one.
      this.framesDropped += 1;
      return true;
    }
    await this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    this.writing = true;
    try {
      while (this.pending && this.telemetry) {
        const bytes = this.pending;
        this.pending = null;
        await this.telemetry.writeValueWithoutResponse(bytes as unknown as BufferSource);
        this.framesSent += 1;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : "BLE write failed.";
    } finally {
      this.writing = false;
      this.emit();
    }
  }

  private async openGatt(): Promise<void> {
    if (!this.device?.gatt) throw new Error("Selected device has no GATT server.");
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(WMAP_BLE_SERVICE_UUID);
    const telemetry = await service.getCharacteristic(WMAP_BLE_TELEMETRY_CHAR_UUID);

    // Device status notifications are the end-to-end ack from the ESP32.
    try {
      const status = await service.getCharacteristic(WMAP_BLE_DEVICE_STATUS_CHAR_UUID);
      status.addEventListener?.("characteristicvaluechanged", (ev) => {
        const v = ev.target.value;
        if (!v) return;
        const res = decodeBleDeviceStatus(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        if (res.ok) {
          this.deviceAck = res.value.lastAcceptedSequence;
          this.emit();
        }
      });
      await status.startNotifications?.();
    } catch {
      // Status notifications are optional; telemetry still works.
    }

    this.telemetry = telemetry;
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.setState("ready"); // only after the telemetry characteristic is in hand
  }

  private onDisconnected(): void {
    this.telemetry = null;
    this.pending = null;
    if (this.userStopped) return;
    void this.tryReconnect();
  }

  private async tryReconnect(): Promise<void> {
    while (!this.userStopped && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts += 1;
      this.setState("reconnecting");
      await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
      if (this.userStopped) return;
      try {
        await this.openGatt();
        return;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : "Reconnect failed.";
        this.emit();
      }
    }
    if (!this.userStopped) this.fail(this.lastError ?? "Bluetooth link lost and could not reconnect.");
  }

  private fail(message: string): void {
    this.lastError = message;
    this.setState("failed");
  }

  private setState(s: BleLinkState): void {
    this.state = s;
    this.emit();
  }

  private emit(): void {
    this.onChange?.(this.getSnapshot());
  }
}
