import { useMemo } from "react";
import {
  isRouteUsable,
  projectPoint,
  projectPolyline,
  type NavigationData,
  type RoutePoint,
  type ScreenPoint,
  type SpeedState,
} from "@w-map/navigation-core";
import type { BackdropRoad } from "../fixtures/demoRoute";
import { SpeedLimitSign } from "./SpeedLimitSign";
import { STATE_STYLES, bannerText } from "./stateStyle";
import { TURN_LABELS, TurnArrow, formatDistance } from "./TurnArrow";

interface Props {
  data: NavigationData;
  speedState: SpeedState;
  linkLabel?: string;
  /** Context roads (lat/lon) from a map provider. Simulated fixtures for now. */
  backdropRoads?: readonly BackdropRoad[];
  metersPerPixel?: number;
}

interface OsmHudTile {
  key: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rider position anchor inside the map viewport (x: 4..236, y: 24..174), placed lower-center for forward look-ahead. */
const ANCHOR: ScreenPoint = [120, 128];
const EMPTY_ROADS: readonly BackdropRoad[] = [];

const toPath = (pts: readonly ScreenPoint[]) =>
  pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

export function formatCardinalHeading(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  const idx = Math.round(normalized / 45) % 8;
  return `${String(Math.round(normalized)).padStart(3, "0")}° ${dirs[idx]}`;
}

interface CompassTapeTick {
  deg: number;
  x: number;
  label: string | null;
  isMajor: boolean;
  isNorth: boolean;
}

const CARDINAL_LABELS: Record<number, string> = {
  0: "N",
  45: "NE",
  90: "E",
  135: "SE",
  180: "S",
  225: "SW",
  270: "W",
  315: "NW",
};

/**
 * Computes sliding horizontal compass tape ticks centered at `centerX = 130`
 * covering `heading ± 75°` at `0.75 px/deg`.
 */
function buildCompassTapeTicks(headingDegrees: number): CompassTapeTick[] {
  const normalized = ((headingDegrees % 360) + 360) % 360;
  const centerX = 130;
  const pxPerDeg = 0.72;
  const ticks: CompassTapeTick[] = [];

  for (let offset = -75; offset <= 75; offset += 1) {
    const rawDeg = Math.round(normalized + offset);
    if (rawDeg % 15 !== 0) continue;
    const deg = ((rawDeg % 360) + 360) % 360;
    const delta = rawDeg - normalized;
    const x = centerX + delta * pxPerDeg;
    const label = CARDINAL_LABELS[deg] ?? null;
    ticks.push({
      deg,
      x,
      label,
      isMajor: deg % 45 === 0,
      isNorth: deg === 0,
    });
  }
  return ticks;
}

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

function latToTileY(lat: number, z: number): number {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clampedLat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

function tileXToLon(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Computes Web Mercator OpenStreetMap street tiles around `(lat, lon)` aligned with `projectPoint`
 * in north-up coordinates so that rotating the tile layer by `-heading` around `ANCHOR` matches
 * the projected route polyline with sub-pixel accuracy.
 */
function buildOsmViewportTiles(lat: number, lon: number, metersPerPixel: number): OsmHudTile[] {
  const z = metersPerPixel <= 1.2 ? 17 : metersPerPixel <= 2.5 ? 16 : 15;
  const n = Math.pow(2, z);
  const centerTileX = Math.floor(lonToTileX(lon, z));
  const centerTileY = Math.floor(latToTileY(lat, z));

  const northUpCfg = {
    center: { latitude: lat, longitude: lon },
    headingDegrees: 0,
    metersPerPixel,
    anchor: ANCHOR,
  };

  const tiles: OsmHudTile[] = [];
  const radius = 1; // 3x3 tile grid easily covers the 232x150 rotated HUD viewport
  const subdomains = ["a", "b", "c"] as const;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = centerTileX + dx;
      const ty = centerTileY + dy;
      if (ty < 0 || ty >= n) continue;
      const wrappedTx = ((tx % n) + n) % n;

      const nwLat = tileYToLat(ty, z);
      const nwLon = tileXToLon(tx, z);
      const seLat = tileYToLat(ty + 1, z);
      const seLon = tileXToLon(tx + 1, z);

      const [x1, y1] = projectPoint({ latitude: nwLat, longitude: nwLon }, northUpCfg);
      const [x2, y2] = projectPoint({ latitude: seLat, longitude: seLon }, northUpCfg);

      const width = Math.max(1, x2 - x1);
      const height = Math.max(1, y2 - y1);
      const sub = subdomains[Math.abs(wrappedTx + ty) % subdomains.length]!;

      tiles.push({
        key: `${z}-${wrappedTx}-${ty}`,
        url: `https://${sub}.tile.openstreetmap.org/${z}/${wrappedTx}/${ty}.png`,
        x: x1 - 0.35,
        y: y1 - 0.35,
        width: width + 0.7,
        height: height + 0.7,
      });
    }
  }

  return tiles;
}

/**
 * Generates a world-anchored geographic street/block grid around (lat, lon) as a fallback underlay
 * while tiles load or when running offline.
 */
function buildWorldGridLines(lat: number, lon: number): RoutePoint[][] {
  const step = 0.0008; // ~88 meters per block
  const baseLat = Math.floor(lat / step) * step;
  const baseLon = Math.floor(lon / step) * step;
  const span = 4;
  const lines: RoutePoint[][] = [];

  for (let i = -span; i <= span; i++) {
    const lineLat = baseLat + i * step;
    lines.push([
      { latitude: lineLat, longitude: baseLon - span * step },
      { latitude: lineLat, longitude: baseLon + span * step },
    ]);
    const lineLon = baseLon + i * step;
    lines.push([
      { latitude: baseLat - span * step, longitude: lineLon },
      { latitude: baseLat + span * step, longitude: lineLon },
    ]);
  }
  return lines;
}

/**
 * MAP mode body: automotive cockpit navigation map (y = 24..226 of the 240x240 display).
 * - Map canvas occupies y = 24..174 with a rounded clip path inside the bezel.
 * - Renders real OpenStreetMap street tiles rotated heading-up around `ANCHOR`, fallback road vectors,
 *   glowing route ribbon with turn nodes, forward heading cone, cardinal compass tape, scale bar,
 *   and a unified bottom telemetry dock.
 */
export function MapDisplay({
  data,
  speedState,
  linkLabel = "SIM BLE",
  backdropRoads = EMPTY_ROADS,
  metersPerPixel = 2,
}: Props) {
  const style = STATE_STYLES[speedState];
  const linkDown = speedState === "DISCONNECTED";
  const navActive = data.routeStatus === "ACTIVE";
  const routeUsable = isRouteUsable(data.routePoints);
  const speedText = linkDown || data.currentSpeedKmh === null ? "--" : String(Math.round(data.currentSpeedKmh));
  const hasHeading = !linkDown && data.headingDegrees !== null && Number.isFinite(data.headingDegrees);
  const heading = hasHeading ? ((data.headingDegrees! % 360) + 360) % 360 : 0;
  const lat = data.latitude;
  const lon = data.longitude;
  const hasPosition = lat !== null && lon !== null;
  const dim = linkDown || style.notCurrent;
  const compassTicks = useMemo(
    () => (hasHeading ? buildCompassTapeTicks(heading) : []),
    [hasHeading, heading],
  );

  const projected = useMemo(() => {
    if (lat === null || lon === null) return null;
    const cfg = {
      center: { latitude: lat, longitude: lon },
      headingDegrees: heading,
      metersPerPixel,
      anchor: ANCHOR,
    };

    const osmTiles = buildOsmViewportTiles(lat, lon, metersPerPixel);
    const worldGridPaths = buildWorldGridLines(lat, lon).map((pts) => toPath(projectPolyline(pts, cfg)));

    const roadPaths = backdropRoads.map((r) => ({
      id: r.id,
      kind: r.kind,
      d: toPath(projectPolyline(r.points, cfg)),
    }));
    const roadLabels = backdropRoads
      .filter((r) => r.name)
      .map((r) => {
        const [x, y] = projectPoint(r.points[1] ?? r.points[0]!, cfg);
        return { id: r.id, name: r.name!, x, y: y - 8 };
      });

    let routePath: string | null = null;
    let routeScreenPts: ScreenPoint[] = [];
    if (navActive && routeUsable) {
      routeScreenPts = projectPolyline(data.routePoints, cfg);
      routePath = toPath(routeScreenPts);
    }

    return { osmTiles, worldGridPaths, roadPaths, roadLabels, routePath, routeScreenPts };
  }, [lat, lon, heading, metersPerPixel, backdropRoads, navActive, routeUsable, data.routePoints]);

  const guidanceDimmed = linkDown || !navActive || style.notCurrent;
  const scaleBarMeters = Math.round(28 * metersPerPixel);
  const endRoutePt =
    projected && projected.routeScreenPts.length >= 2
      ? projected.routeScreenPts[projected.routeScreenPts.length - 1]!
      : null;
  const nextTurnNodePt =
    projected && projected.routeScreenPts.length >= 3 ? projected.routeScreenPts[1]! : null;

  return (
    <g data-testid="map-display">
      <defs>
        <clipPath id="wmap-viewport-clip">
          <rect x={4} y={24} width={232} height={150} rx={10} />
        </clipPath>
        <clipPath id="wmap-compass-tape-clip">
          <rect x={78} y={42} width={104} height={13} rx={3} />
        </clipPath>
        <linearGradient id="wmap-sky-horizon" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#070b10" stopOpacity={0.85} />
          <stop offset="22%" stopColor="#0b1119" stopOpacity={0} />
        </linearGradient>
        <linearGradient id="wmap-heading-cone" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#0284c7" stopOpacity={0.38} />
          <stop offset="100%" stopColor="#0284c7" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Clipped Map Viewport (inset cleanly inside the 240x240 bezel) */}
      <g clipPath="url(#wmap-viewport-clip)">
        {/* Fallback dark base before tiles load */}
        <rect x={4} y={24} width={232} height={150} fill="#0b1017" />

        {/* Fallback world-anchored rotating city block mesh (visible when offline or before tiles load) */}
        {projected && (
          <g opacity={dim ? 0.25 : 0.55}>
            {projected.worldGridPaths.map((d, idx) => (
              <path key={`wg-${idx}`} d={d} fill="none" stroke="#131c27" strokeWidth={1.2} />
            ))}
          </g>
        )}

        {/* Real OpenStreetMap Street Tiles rotated heading-up around ANCHOR */}
        {projected && (
          <g
            data-testid="map-osm-tiles"
            transform={`rotate(${-heading} ${ANCHOR[0]} ${ANCHOR[1]})`}
            opacity={dim ? 0.45 : 0.96}
          >
            {projected.osmTiles.map((tile) => (
              <image
                key={tile.key}
                href={tile.url}
                x={tile.x}
                y={tile.y}
                width={tile.width}
                height={tile.height}
                preserveAspectRatio="none"
              />
            ))}
          </g>
        )}

        {/* Subtle range ring around rider anchor */}
        <circle
          cx={ANCHOR[0]}
          cy={ANCHOR[1]}
          r={34}
          fill="none"
          stroke="#0284c7"
          strokeOpacity={0.35}
          strokeWidth={0.9}
          strokeDasharray="3 3"
        />

        {/* Context roads from synthetic fixtures (when provided) */}
        {projected && (
          <g data-testid="map-roads" opacity={dim ? 0.35 : 0.72}>
            {projected.roadPaths.map((r) => (
              <g key={r.id}>
                <path
                  d={r.d}
                  fill="none"
                  stroke="#070a0f"
                  strokeWidth={r.kind === "MAJOR" ? 11 : 7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={r.d}
                  fill="none"
                  stroke={r.kind === "MAJOR" ? "#334155" : "#1e293b"}
                  strokeWidth={r.kind === "MAJOR" ? 8 : 4.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  data-road={r.id}
                />
              </g>
            ))}
            {projected.roadLabels.map((l) => {
              const badgeW = Math.max(28, l.name.length * 4.5 + 8);
              return (
                <g key={`l-${l.id}`}>
                  <rect
                    x={l.x - badgeW / 2}
                    y={l.y - 7.5}
                    width={badgeW}
                    height={10.5}
                    rx={3}
                    fill="#0d131c"
                    stroke="#283445"
                    strokeWidth={0.7}
                    opacity={0.9}
                  />
                  <text
                    x={l.x}
                    y={l.y}
                    textAnchor="middle"
                    fontSize={6.8}
                    fontWeight={700}
                    fill="#cbd5e1"
                    data-testid="road-label"
                  >
                    {l.name}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* Active route polyline with outer glow, dark casing, cyan ribbon, flow dashes, and turn/destination nodes */}
        {projected?.routePath && (
          <g opacity={dim ? 0.45 : 1}>
            <path
              d={projected.routePath}
              fill="none"
              stroke="#0284c7"
              strokeOpacity={0.35}
              strokeWidth={12}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={projected.routePath}
              fill="none"
              stroke="#082f49"
              strokeWidth={8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={projected.routePath}
              fill="none"
              stroke="#00d2ff"
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
              data-testid="map-route"
            />
            <path
              d={projected.routePath}
              fill="none"
              stroke="#ffffff"
              strokeWidth={1.4}
              strokeDasharray="2.5 7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {nextTurnNodePt && (
              <circle
                cx={nextTurnNodePt[0]}
                cy={nextTurnNodePt[1]}
                r={3.8}
                fill="#ffffff"
                stroke="#0284c7"
                strokeWidth={1.6}
              />
            )}
            {endRoutePt && (
              <g transform={`translate(${endRoutePt[0].toFixed(1)} ${endRoutePt[1].toFixed(1)})`}>
                <circle r={6} fill="#ff5a5f" stroke="#ffffff" strokeWidth={1.6} />
                <circle r={2.2} fill="#ffffff" />
              </g>
            )}
          </g>
        )}

        {/* Rider forward heading cone + 3D delta chevron marker */}
        {hasPosition ? (
          <g
            transform={`translate(${ANCHOR[0]} ${ANCHOR[1]})`}
            data-testid="position-marker"
            data-heading={hasHeading ? heading : "none"}
            data-gps={data.gpsStatus}
          >
            {data.gpsStatus === "ACTIVE" && hasHeading && (
              <polygon points="0,0 -24,-52 24,-52" fill="url(#wmap-heading-cone)" />
            )}
            <circle r={11.5} fill={data.gpsStatus === "ACTIVE" ? "#0284c7" : "#f5a524"} opacity={0.28} />
            <polygon
              points="0,-10 7.5,8 0,4 -7.5,8"
              fill={data.gpsStatus === "ACTIVE" ? "#2ea8ff" : "#8b93a1"}
              stroke="#090d14"
              strokeWidth={1.8}
            />
            {data.gpsStatus === "ACTIVE" && (
              <polygon points="0,-9 6.5,7 0,3.5" fill="#e0f2fe" />
            )}
          </g>
        ) : (
          <g>
            <rect x={68} y={90} width={104} height={20} rx={5} fill="#141922" stroke="#f5a524" strokeWidth={1} />
            <text
              x={120}
              y={103.5}
              textAnchor="middle"
              fontSize={10}
              fontWeight={800}
              fill="#f5a524"
              data-testid="map-no-position"
            >
              NO POSITION
            </text>
          </g>
        )}

        {navActive && !routeUsable && (
          <g>
            <rect
              x={58}
              y={66}
              width={124}
              height={18}
              rx={5}
              fill="#141922"
              stroke="#f5a524"
              strokeWidth={1}
              opacity={0.94}
            />
            <text
              x={120}
              y={78}
              textAnchor="middle"
              fontSize={9}
              fontWeight={800}
              fill="#f5a524"
              data-testid="map-no-route"
            >
              ROUTE UNAVAILABLE
            </text>
          </g>
        )}

        {/* Top horizon vignette */}
        <rect x={4} y={24} width={232} height={28} fill="url(#wmap-sky-horizon)" />

        {/* Top HUD Strip: State Banner (left), Heading Readout (center), Route Status + Compass (right) */}
        <rect x={8} y={27} width={96} height={15} rx={4} fill="#0b0f17" stroke="#1e293b" strokeWidth={0.8} opacity={0.92} />
        <text
          x={13}
          y={37.5}
          fontSize={7.8}
          fontWeight={800}
          fill={style.color}
          data-testid="state-banner"
          data-state={speedState}
        >
          {bannerText(speedState, linkLabel)}
        </text>

        {/* Center Cardinal Heading Pill (never fakes 000° N when headingDegrees is null) */}
        <rect
          x={108}
          y={27}
          width={44}
          height={15}
          rx={4}
          fill="#0b0f17"
          stroke={hasHeading ? "#38bdf8" : "#1e293b"}
          strokeWidth={0.8}
          opacity={0.92}
        />
        <text
          x={130}
          y={37.5}
          textAnchor="middle"
          fontSize={7.8}
          fontWeight={800}
          fill={hasHeading ? "#e2e8f0" : "#64748b"}
          data-testid="compass-heading"
          data-compass={hasHeading ? "ACTIVE" : "UNAVAILABLE"}
        >
          {hasHeading ? formatCardinalHeading(heading) : "---° --"}
        </text>

        {/* Sliding Horizontal Compass Tape (graduated every 15° with N/NE/E/SE/S/SW/W/NW markers) */}
        {hasHeading && (
          <g data-testid="compass-tape">
            <rect
              x={78}
              y={43}
              width={104}
              height={12}
              rx={3}
              fill="#0b0f17"
              stroke="#1e293b"
              strokeWidth={0.7}
              opacity={0.88}
            />
            <g clipPath="url(#wmap-compass-tape-clip)">
              {compassTicks.map((t) => (
                <g key={`ct-${t.deg}`}>
                  <line
                    x1={t.x}
                    y1={43}
                    x2={t.x}
                    y2={t.isMajor ? 47.2 : 45.6}
                    stroke={t.isNorth ? "#ff5a5f" : t.isMajor ? "#94a3b8" : "#475569"}
                    strokeWidth={t.isMajor ? 1 : 0.7}
                  />
                  {t.label && (
                    <text
                      x={t.x}
                      y={53.2}
                      textAnchor="middle"
                      fontSize={5.8}
                      fontWeight={800}
                      fill={t.isNorth ? "#ff5a5f" : "#cbd5e1"}
                    >
                      {t.label}
                    </text>
                  )}
                </g>
              ))}
            </g>
            {/* Center Lubber Triangle pointing at active heading */}
            <polygon points="130,44.8 127.8,42.2 132.2,42.2" fill="#38bdf8" />
          </g>
        )}

        {/* Route Status Pill */}
        <rect x={156} y={27} width={46} height={15} rx={4} fill="#0b0f17" stroke="#1e293b" strokeWidth={0.8} opacity={0.92} />
        <text
          x={179}
          y={37.5}
          textAnchor="middle"
          fontSize={7.2}
          fontWeight={800}
          fill={navActive ? "#34d399" : "#9aa3b2"}
          data-testid="route-status"
        >
          {navActive ? "NAV ACTIVE" : "NAV OFF"}
        </text>

        {/* Graduated 360° Rotating North Compass Rose */}
        <g
          transform="translate(219 39)"
          data-testid="north-indicator"
          data-compass={hasHeading ? "ACTIVE" : "UNAVAILABLE"}
        >
          <circle
            r={11.5}
            fill="#0b0f17"
            stroke={hasHeading ? "#38bdf8" : "#283548"}
            strokeWidth={0.9}
            opacity={0.94}
          />
          {/* Degree dial ticks around the compass bezel */}
          <circle
            r={9.5}
            fill="none"
            stroke="#475569"
            strokeWidth={1.2}
            strokeDasharray="0.9 2.2"
            opacity={hasHeading ? 0.85 : 0.35}
          />
          <g transform={`rotate(${-heading})`} opacity={hasHeading ? 1 : 0.32}>
            <polygon points="0,-8.2 2.8,1.5 -2.8,1.5" fill="#ff5a5f" />
            <polygon points="0,8.2 2.8,-1.5 -2.8,-1.5" fill="#64748b" />
            <circle r={1.5} fill="#e2e8f0" />
          </g>
        </g>

        {/* Map Scale Bar (bottom-right of map viewport) */}
        <g transform="translate(194 164)">
          <rect x={-4} y={-8} width={38} height={11} rx={3} fill="#0b0f17" opacity={0.85} />
          <path d="M0,-1 V2 H28 V-1" fill="none" stroke="#94a3b8" strokeWidth={1.1} />
          <text x={14} y={-2} textAnchor="middle" fontSize={6.5} fontWeight={700} fill="#cbd5e1">
            {scaleBarMeters} m
          </text>
        </g>

        {/* Subtle watermark caption at bottom-left of map canvas */}
        <rect x={7} y={161} width={118} height={10} rx={2.5} fill="#0b0f17" opacity={0.78} />
        <text x={10} y={168.5} fontSize={6.2} fontWeight={600} fill="#cbd5e1" data-testid="map-disclaimer">
          © OSM · SIMULATED MAP - NOT REAL DATA
        </text>
      </g>

      {/* Crisp Map Viewport Frame */}
      <rect x={4} y={24} width={232} height={150} rx={10} fill="none" stroke="#222d3d" strokeWidth={1.2} />

      {/* Integrated Bottom Instrument Dock (y = 177..225) */}
      <rect x={4} y={177} width={232} height={48} rx={9} fill="#11161f" stroke="#222b38" strokeWidth={1.2} />
      <line x1={114} y1={182} x2={114} y2={220} stroke="#222b38" strokeWidth={1.2} />

      {/* Left Instrument Cell: Speed + Speed Limit */}
      <text
        x={38}
        y={206}
        textAnchor="middle"
        fontSize={30}
        fontWeight={800}
        fill={style.speedColor}
        data-testid="speed-value"
        data-state={speedState}
      >
        {speedText}
      </text>
      <text x={38} y={219} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="#9aa3b2">
        km/h
      </text>
      <SpeedLimitSign
        cx={90}
        cy={197}
        r={13.5}
        limitKmh={data.speedLimitKmh}
        status={data.speedLimitStatus}
        inactive={style.notCurrent}
      />

      {/* Right Instrument Cell: Upcoming Turn Arrow + Distance */}
      <g transform="translate(138 201) scale(0.42)" opacity={guidanceDimmed ? 0.3 : 1}>
        <TurnArrow direction={data.turnDirection} />
      </g>
      <text
        x={162}
        y={201}
        fontSize={navActive ? 19 : 15}
        fontWeight={800}
        fill={guidanceDimmed ? "#8b93a1" : "#ffffff"}
        data-testid="distance-value"
      >
        {navActive && !linkDown ? formatDistance(data.distanceToTurnMeters) : "--"}
      </text>
      <text x={162} y={216} fontSize={8} fontWeight={700} fill={navActive ? "#94a3b8" : "#64748b"}>
        {navActive ? TURN_LABELS[data.turnDirection].toUpperCase() : "NO ACTIVE ROUTE"}
      </text>
    </g>
  );
}
