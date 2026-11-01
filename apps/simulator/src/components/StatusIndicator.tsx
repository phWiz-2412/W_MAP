import type { BLEStatus, GPSStatus } from "@w-map/navigation-core";

interface Props {
  gps: GPSStatus | null;
  ble: BLEStatus | null;
}

function Chip({ x, w, label, ok, testId, state }: { x: number; w: number; label: string; ok: boolean; testId: string; state: string }) {
  const color = ok ? "#34d399" : "#ff5a5f";
  return (
    <g data-testid={testId} data-state={state}>
      <rect x={x} y={4} width={w} height={16} rx={8} fill="#161a21" stroke={color} strokeWidth={1.2} />
      <circle cx={x + 9} cy={12} r={3} fill={color} />
      <text x={x + 16} y={15.5} fontSize={9} fontWeight={700} fill={color}>
        {label}
      </text>
    </g>
  );
}

/** Top status bar: GPS and (simulated) BLE link state. */
export function StatusIndicator({ gps, ble }: Props) {
  const gpsOk = gps === "ACTIVE";
  const bleOk = ble === "CONNECTED";
  return (
    <g>
      <Chip x={6} w={74} label={gpsOk ? "GPS OK" : "GPS LOST"} ok={gpsOk} testId="gps-status" state={gps ?? "NONE"} />
      <Chip
        x={86}
        w={148}
        label={bleOk ? "SIM BLE LINKED" : "SIM BLE DISCONNECTED"}
        ok={bleOk}
        testId="ble-status"
        state={ble ?? "NONE"}
      />
    </g>
  );
}
