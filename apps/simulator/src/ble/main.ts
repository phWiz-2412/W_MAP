import type { BleTelemetryFrame } from "@w-map/navigation-core";
import { WebBleLink, type BleLinkSnapshot } from "./WebBleLink";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const connectBtn = $("connect") as HTMLButtonElement;
const startBtn = $("start") as HTMLButtonElement;
const stopBtn = $("stop") as HTMLButtonElement;

function render(s: BleLinkSnapshot) {
  const el = $("state");
  el.textContent = s.state === "ready" ? "READY (GATT telemetry characteristic found)" : s.state;
  el.className = s.state === "ready" ? "ready" : s.state === "failed" ? "failed" : "wait";
  $("error").textContent = s.lastError ?? "";
  $("dev").textContent = s.deviceName ?? "--";
  $("sent").textContent = String(s.framesSent);
  $("dropped").textContent = String(s.framesDropped);
  $("seq").textContent = s.lastSentSequence === null ? "--" : String(s.lastSentSequence);
  $("ack").textContent = s.deviceAckSequence === null ? "-- (no ack yet)" : String(s.deviceAckSequence);
  $("unacked").textContent = s.unackedFrames === null ? "--" : String(s.unackedFrames);
  startBtn.disabled = s.state !== "ready" || timer !== null;
  stopBtn.disabled = s.state === "idle";
}

let timer: ReturnType<typeof setInterval> | null = null;
let seq = 0;
const sessionId = (Math.floor(Math.random() * 65534) % 65534) + 1;
const t0 = performance.now();
const link = new WebBleLink({ onChange: render });

if (!link.isSupported) {
  $("error").textContent = "Web Bluetooth is unavailable in this browser. Use Chrome/Edge (on localhost or HTTPS).";
  connectBtn.disabled = true;
}

function testFrame(): BleTelemetryFrame {
  seq = (seq + 1) & 0xffff;
  const t = (performance.now() - t0) / 1000;
  return {
    version: 1,
    msgType: 0x01,
    sessionId,
    sequenceNumber: seq,
    timestampMs: Math.floor(performance.now()) >>> 0,
    gpsStatus: "ACTIVE",
    routeStatus: "ACTIVE",
    speedLimitStatus: "UNKNOWN",
    isOffRoute: false,
    hasArrived: false,
    turnDirection: "LEFT",
    currentSpeedKmh: Math.round(30 + 20 * Math.sin(t / 3)), // synthetic
    speedLimitKmh: null,
    gpsAccuracyMeters: 5,
    distanceToTurnMeters: Math.max(0, 500 - Math.floor(t * 10) % 500), // synthetic countdown
    remainingDistanceMeters: 5000,
    etaDurationMinutes: 12,
    headingDegrees: (t * 20) % 360, // synthetic rotation
    latitude: 15.9786,
    longitude: 108.2526,
  };
}

connectBtn.addEventListener("click", () => void link.connect());
startBtn.addEventListener("click", () => {
  timer = setInterval(() => void link.sendTelemetry(testFrame()), 200);
  startBtn.disabled = true;
});
stopBtn.addEventListener("click", () => {
  if (timer) clearInterval(timer);
  timer = null;
  link.disconnect();
});
render(link.getSnapshot());
