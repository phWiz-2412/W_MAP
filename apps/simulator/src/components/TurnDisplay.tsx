import type { NavigationData, SpeedState } from "@w-map/navigation-core";
import { SpeedLimitSign } from "./SpeedLimitSign";
import { STATE_STYLES } from "./stateStyle";
import { TurnArrow, formatDistance } from "./TurnArrow";

interface Props {
  data: NavigationData;
  speedState: SpeedState;
}

/** TURN mode body (y = 26..226 of the 240x240 display). */
export function TurnDisplay({ data, speedState }: Props) {
  const style = STATE_STYLES[speedState];
  const linkDown = speedState === "DISCONNECTED";
  const speedText = linkDown || data.currentSpeedKmh === null ? "--" : String(Math.round(data.currentSpeedKmh));
  const navActive = data.routeStatus === "ACTIVE";
  const guidanceDimmed = linkDown || !navActive || style.notCurrent;
  return (
    <g data-testid="turn-display">
      <text x={92} y={102} textAnchor="middle" fontSize={72} fontWeight={800} fill={style.speedColor} data-testid="speed-value" data-state={speedState}>
        {speedText}
      </text>
      <text x={92} y={120} textAnchor="middle" fontSize={13} fontWeight={600} fill="#9aa3b2">
        km/h
      </text>

      <SpeedLimitSign cx={200} cy={64} r={27} limitKmh={data.speedLimitKmh} status={data.speedLimitStatus} inactive={style.notCurrent} />

      <rect x={8} y={130} width={224} height={22} rx={6} fill="#161a21" stroke={style.color} strokeWidth={1.5} />
      <text x={120} y={146} textAnchor="middle" fontSize={12} fontWeight={800} fill={style.color} data-testid="state-banner" data-state={speedState}>
        {style.banner}
      </text>

      <g transform="translate(52 193)" opacity={guidanceDimmed ? 0.3 : 1}>
        <TurnArrow direction={data.turnDirection} />
      </g>
      <text x={104} y={198} fontSize={navActive ? 36 : 22} fontWeight={800} fill={guidanceDimmed ? "#8b93a1" : "#ffffff"} data-testid="distance-value">
        {navActive && !linkDown ? formatDistance(data.distanceToTurnMeters) : "--"}
      </text>
      <text x={104} y={218} fontSize={10} fontWeight={700} fill={navActive ? "#34d399" : "#9aa3b2"} data-testid="route-status">
        {navActive ? "NAV ACTIVE" : "NAV OFF"}
      </text>
    </g>
  );
}
