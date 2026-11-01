import {
  isRouteUsable,
  projectPoint,
  projectPolyline,
  type NavigationData,
  type ScreenPoint,
  type SpeedState,
} from "@w-map/navigation-core";
import type { BackdropRoad } from "../fixtures/demoRoute";
import { SpeedLimitSign } from "./SpeedLimitSign";
import { STATE_STYLES } from "./stateStyle";
import { TurnArrow, formatDistance } from "./TurnArrow";

interface Props {
  data: NavigationData;
  speedState: SpeedState;
  /** Context roads (lat/lon) from a map provider. Simulated fixtures for now. */
  backdropRoads?: readonly BackdropRoad[];
  metersPerPixel?: number;
}

/** Where the current position is drawn on the 240x240 display. */
const ANCHOR: ScreenPoint = [120, 140];

const toPath = (pts: readonly ScreenPoint[]) => pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

/** MAP mode body: heading-up map centered on the current position. */
export function MapDisplay({ data, speedState, backdropRoads = [], metersPerPixel = 2 }: Props) {
  const style = STATE_STYLES[speedState];
  const linkDown = speedState === "DISCONNECTED";
  const navActive = data.routeStatus === "ACTIVE";
  const routeUsable = isRouteUsable(data.routePoints);
  const speedText = linkDown || data.currentSpeedKmh === null ? "--" : String(Math.round(data.currentSpeedKmh));
  const heading = data.headingDegrees ?? 0;
  const hasPosition = data.latitude !== null && data.longitude !== null;
  const dim = linkDown || style.notCurrent;

  const cfg = hasPosition
    ? { center: { latitude: data.latitude!, longitude: data.longitude! }, headingDegrees: heading, metersPerPixel, anchor: ANCHOR }
    : null;
  const routePath = cfg && navActive && routeUsable ? toPath(projectPolyline(data.routePoints, cfg)) : null;
  const guidanceDimmed = linkDown || !navActive || style.notCurrent;

  return (
    <g data-testid="map-display">
      <svg x={0} y={26} width={240} height={200} viewBox="0 26 240 200" overflow="hidden">
        <rect x={0} y={26} width={240} height={200} fill="#10141a" />
        {cfg && (
          <g data-testid="map-roads" opacity={dim ? 0.4 : 1}>
            {backdropRoads.map((r) => (
              <path
                key={r.id}
                d={toPath(projectPolyline(r.points, cfg))}
                fill="none"
                stroke={r.kind === "MAJOR" ? "#4b5565" : "#2c3440"}
                strokeWidth={r.kind === "MAJOR" ? 9 : 5}
                strokeLinecap="round"
                strokeLinejoin="round"
                data-road={r.id}
              />
            ))}
            {backdropRoads
              .filter((r) => r.name)
              .map((r) => {
                const [x, y] = projectPoint(r.points[1] ?? r.points[0]!, cfg);
                return (
                  <text key={`l-${r.id}`} x={x + 8} y={y - 6} fontSize={8} fill="#7a8494" data-testid="road-label">
                    {r.name}
                  </text>
                );
              })}
          </g>
        )}
        {routePath && (
          <path d={routePath} fill="none" stroke="#2ea8ff" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" data-testid="map-route" opacity={dim ? 0.4 : 1} />
        )}

        {hasPosition ? (
          <g transform={`translate(${ANCHOR[0]} ${ANCHOR[1]})`} data-testid="position-marker" data-heading={heading} data-gps={data.gpsStatus}>
            <circle r={12} fill={data.gpsStatus === "ACTIVE" ? "#2ea8ff" : "#f5a524"} opacity={0.25} />
            <polygon points="0,-11 8,9 0,4 -8,9" fill={data.gpsStatus === "ACTIVE" ? "#ffffff" : "#8b93a1"} stroke="#0b0d10" strokeWidth={1.5} />
          </g>
        ) : (
          <text x={120} y={120} textAnchor="middle" fontSize={12} fontWeight={800} fill="#f5a524" data-testid="map-no-position">
            NO POSITION
          </text>
        )}
        {navActive && !routeUsable && (
          <text x={120} y={104} textAnchor="middle" fontSize={11} fontWeight={800} fill="#f5a524" data-testid="map-no-route">
            ROUTE UNAVAILABLE
          </text>
        )}

        {/* North indicator: shows where north is for the current heading-up orientation */}
        <g transform="translate(22 88)" data-testid="north-indicator">
          <circle r={11} fill="#0b0d10" opacity={0.85} />
          <g transform={`rotate(${-heading})`}>
            <polygon points="0,-8 4,3 -4,3" fill="#ff5a5f" />
          </g>
        </g>

        {/* HUD overlays */}
        <rect x={4} y={168} width={74} height={54} rx={8} fill="#0b0d10" opacity={0.85} />
        <text x={41} y={202} textAnchor="middle" fontSize={34} fontWeight={800} fill={style.speedColor} data-testid="speed-value" data-state={speedState}>
          {speedText}
        </text>
        <text x={41} y={217} textAnchor="middle" fontSize={9} fill="#9aa3b2">
          km/h
        </text>
        <rect x={150} y={168} width={86} height={54} rx={8} fill="#0b0d10" opacity={0.85} />
        <g transform="translate(176 195) scale(0.42)" opacity={guidanceDimmed ? 0.3 : 1}>
          <TurnArrow direction={data.turnDirection} />
        </g>
        <text x={196} y={200} fontSize={navActive ? 17 : 14} fontWeight={800} fill="#ffffff" data-testid="distance-value">
          {navActive && !linkDown ? formatDistance(data.distanceToTurnMeters) : "--"}
        </text>
        <SpeedLimitSign cx={212} cy={58} r={18} limitKmh={data.speedLimitKmh} status={data.speedLimitStatus} inactive={style.notCurrent} />
        <rect x={4} y={30} width={128} height={16} rx={4} fill="#0b0d10" opacity={0.85} />
        <text x={9} y={41.5} fontSize={9} fontWeight={700} fill={style.color} data-testid="state-banner" data-state={speedState}>
          {style.banner}
        </text>
        <text x={9} y={58} fontSize={8} fontWeight={700} fill="#f5a524" data-testid="map-disclaimer">
          SIMULATED MAP - NOT REAL DATA
        </text>
        <text x={190} y={41.5} textAnchor="end" fontSize={8} fontWeight={700} fill={navActive ? "#34d399" : "#9aa3b2"} data-testid="route-status">
          {navActive ? "NAV ACTIVE" : "NAV OFF"}
        </text>
      </svg>
    </g>
  );
}
