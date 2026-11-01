import { coordsToGpsMessage, describeGeoError } from "./gpsReporter";

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

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?role=phone`);
  ws.onopen = () => (linkEl.textContent = "Link to display: connected");
  ws.onclose = () => {
    linkEl.textContent = "Link to display: disconnected";
    if (wanted) reconnectTimer = window.setTimeout(connect, 1500);
  };
  ws.onerror = () => ws?.close();
}

function start() {
  if (!("geolocation" in navigator)) {
    errEl.textContent = "Geolocation is not supported by this browser.";
    return;
  }
  wanted = true;
  errEl.textContent = "";
  connect();
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const msg = coordsToGpsMessage(pos.coords);
      speedEl.textContent = msg.speedMps === null ? "--" : String(Math.round(msg.speedMps * 3.6));
      infoEl.textContent = `accuracy ${msg.accuracyMeters === null ? "?" : Math.round(msg.accuracyMeters)} m - ${msg.latitude.toFixed(5)}, ${msg.longitude.toFixed(5)}`;
      errEl.textContent = "";
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    (err) => (errEl.textContent = describeGeoError(err.code)),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
  );
  navigator.wakeLock?.request("screen").then((l) => (wakeLock = l)).catch(() => undefined);
  startBtn.disabled = true;
  stopBtn.disabled = false;
}

function stop() {
  wanted = false;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  window.clearTimeout(reconnectTimer);
  ws?.close();
  void wakeLock?.release();
  wakeLock = null;
  speedEl.textContent = "--";
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
