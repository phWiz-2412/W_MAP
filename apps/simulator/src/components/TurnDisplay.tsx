import type { NavigationData, SpeedState } from "@w-map/navigation-core";
import { formatCardinalHeading } from "./MapDisplay";
import { SpeedLimitSign } from "./SpeedLimitSign";
import { STATE_STYLES, bannerText } from "./stateStyle";
import { TURN_LABELS, TurnArrow, formatDistance } from "./TurnArrow";

interface Props {
  data: NavigationData;
  speedState: SpeedState;
  linkLabel?: string;
}

/** TURN mode body (y = 26..226 of the 240x240 display). */
export function TurnDisplay({ data, speedState, linkLabel = "SIM BLE" }: Props) {
  const style = STATE_STYLES[speedState];
  const linkDown = speedState === "DISCONNECTED";
  const speedText = linkDown || data.currentSpeedKmh === null ? "--" : String(Math.round(data.currentSpeedKmh));
  const hasHeading = !linkDown && data.headingDegrees !== null && Number.isFinite(data.headingDegrees);
  const navActive = data.routeStatus === "ACTIVE";
  const guidanceDimmed = linkDown || !navActive || style.notCurrent;
  return (
    <g data-testid="turn-display">
      {/* Upper Speedometer & Speed Limit Zone */}
      <text
        x={90}
        y={98}
        textAnchor="middle"
        fontSize={70}
        fontWeight={800}
        fill={style.speedColor}
        data-testid="speed-value"
        data-state={speedState}
      >
        {speedText}
      </text>
      <text x={90} y={116} textAnchor="middle" fontSize={12} fontWeight={700} fill="#9aa3b2">
        km/h
      </text>

      <SpeedLimitSign
        cx={194}
        cy={62}
        r={24}
        limitKmh={data.speedLimitKmh}
        status={data.speedLimitStatus}
        inactive={style.notCurrent}
      />

      {/* Real Compass Heading Badge in TURN Mode */}
      <rect
        x={160}
        y={96}
        width={68}
        height={18}
        rx={5}
        fill="#11161f"
        stroke={hasHeading ? "#38bdf8" : "#222b38"}
        strokeWidth={1}
      />
      <text
        x={194}
        y={108}
        textAnchor="middle"
        fontSize={9}
        fontWeight={800}
        fill={hasHeading ? "#e2e8f0" : "#64748b"}
        data-testid="turn-compass"
        data-compass={hasHeading ? "ACTIVE" : "UNAVAILABLE"}
      >
        {hasHeading ? formatCardinalHeading(data.headingDegrees!) : "---° --"}
      </text>

      {/* Status Banner Pill */}
      <rect x={6} y={126} width={228} height={22} rx={6} fill="#141922" stroke={style.color} strokeWidth={1.4} />
      <text
        x={120}
        y={141}
        textAnchor="middle"
        fontSize={11.5}
        fontWeight={800}
        fill={style.color}
        data-testid="state-banner"
        data-state={speedState}
      >
        {bannerText(speedState, linkLabel)}
      </text>

      {/* Lower Turn-by-Turn Guidance Dock */}
      <rect x={6} y={154} width={228} height={70} rx={10} fill="#11161f" stroke="#222b38" strokeWidth={1.2} />
      <g transform="translate(48 190) scale(0.76)" opacity={guidanceDimmed ? 0.3 : 1}>
        <TurnArrow direction={data.turnDirection} />
      </g>
      <text
        x={96}
        y={191}
        fontSize={navActive ? 34 : 22}
        fontWeight={800}
        fill={guidanceDimmed ? "#8b93a1" : "#ffffff"}
        data-testid="distance-value"
      >
        {navActive && !linkDown ? formatDistance(data.distanceToTurnMeters) : "--"}
      </text>
      <text x={96} y={207} fontSize={9.5} fontWeight={600} fill="#94a3b8">
        {navActive ? TURN_LABELS[data.turnDirection] : "No route active"}
      </text>
      <text
        x={224}
        y={217}
        textAnchor="end"
        fontSize={8.5}
        fontWeight={800}
        fill={navActive ? "#34d399" : "#9aa3b2"}
        data-testid="route-status"
      >
        {navActive ? "NAV ACTIVE" : "NAV OFF"}
      </text>
    </g>
  );
}
