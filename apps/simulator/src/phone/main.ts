import {
  LIVE_WATCH_OPTIONS,
  coordsToGpsMessage,
  describeGeoError,
  type PositionSampleLike,
} from "./gpsReporter";

/** Phone page: reads REAL GPS via the browser Geolocation API and sends it to the display over WebSocket. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const speedEl = $("speed");
const infoEl = $("info");
const linkEl = $("link");
const errEl = $("error");

let watchId: number | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: number | undefined;
let wakeLock: WakeLockSentinel | null = null;
let wanted = false;
let sessionId = "";
let phoneSeq = 0;
let previousSample: PositionSampleLike | null = null;
/** Single-slot latest-sample buffer when socket is connecting; older unsent samples are discarded so stale backlog is never replayed. */
let latestPendingMessage: string | null = null;

function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function closeSocketCleanly() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
}

function connect() {
  closeSocketCleanly();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws?role=phone`);
  ws = socket;
  socket.onopen = () => {
    linkEl.textContent = "Link to display: connected";
    if (latestPendingMessage !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(latestPendingMessage);
      latestPendingMessage = null;
    }
  };
  socket.onclose = () => {
    linkEl.textContent = "Link to display: disconnected";
    ws = null;
    if (wanted) reconnectTimer = window.setTimeout(connect, 1000);
  };
  socket.onerror = () => socket.close();
}

function start() {
  if (!("geolocation" in navigator)) {
    errEl.textContent = "Geolocation is not supported by this browser.";
    return;
  }
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  wanted = true;
  sessionId = newSessionId();
  phoneSeq = 0;
  previousSample = null;
  latestPendingMessage = null;
  errEl.textContent = "";
  connect();

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const receivedAtMs = Date.now();
      phoneSeq += 1;
      const sampleTimestampMs = Number.isFinite(pos.timestamp) ? pos.timestamp : receivedAtMs;
      const sentAtMs = Date.now();
      const msg = coordsToGpsMessage(pos.coords, {
        sampleTimestampMs,
        phoneReceivedAtMs: receivedAtMs,
        phoneSentAtMs: sentAtMs,
        phoneSessionId: sessionId,
        phoneSeq,
        previousSample,
      });
      previousSample = { coords: pos.coords, timestamp: sampleTimestampMs };

      speedEl.textContent = msg.speedMps === null ? "--" : String(Math.round(msg.speedMps * 3.6));
      const srcTag = msg.speedSource === "derived" ? " (derived)" : "";
      infoEl.textContent = `seq #${phoneSeq} | accuracy ${msg.accuracyMeters === null ? "?" : Math.round(msg.accuracyMeters)} m${srcTag} - ${msg.latitude.toFixed(5)}, ${msg.longitude.toFixed(5)}`;
      errEl.textContent = "";

      const payload = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        latestPendingMessage = null;
      } else {
        latestPendingMessage = payload;
      }
    },
    (err) => (errEl.textContent = describeGeoError(err.code)),
    LIVE_WATCH_OPTIONS,
  );
  navigator.wakeLock?.request("screen").then((l) => (wakeLock = l)).catch(() => undefined);
  startBtn.disabled = true;
  stopBtn.disabled = false;
}

function stop() {
  wanted = false;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  previousSample = null;
  latestPendingMessage = null;
  closeSocketCleanly();
  linkEl.textContent = "Link to display: stopped";
  void wakeLock?.release();
  wakeLock = null;
  speedEl.textContent = "--";
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
