import { useState, type ChangeEvent } from "react";
import { TURN_DIRECTIONS, type NavigationMode, type RouteFixture } from "@w-map/navigation-core";
import { VN_ROUTE_FIXTURES, getBuiltInFixtureById } from "../fixtures/vnFixtures";
import type { SimulatorControls } from "../services/SimulatorService";

const SPEED_LIMIT_OPTIONS: readonly (number | null)[] = [null, 30, 40, 50, 60, 80, 100];

interface Props {
  controls: SimulatorControls;
  activeFixture?: RouteFixture | null;
  onChange: (patch: Partial<SimulatorControls>) => void;
  onReset: () => void;
  onLoadFixture?: (fixture: RouteFixture) => void;
  onLoadFixtureJson?: (rawJson: string) => { ok: boolean; errors?: string[] };
  warningThresholdKmh: number;
  onThresholdChange: (value: number) => void;
}

interface RangeProps {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  disabled?: boolean;
  prefix?: string;
  onChange: (v: number) => void;
}

function RangeField({ id, label, unit, min, max, step = 1, value, disabled, prefix = "", onChange }: RangeProps) {
  return (
    <div className="field">
      <div className="row">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {prefix}
          {value} {unit}
        </output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

interface SelectProps<T extends string> {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}

function SelectField<T extends string>({ id, label, value, options, onChange }: SelectProps<T>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SimulatorPanel({
  controls: c,
  activeFixture,
  onChange,
  onReset,
  onLoadFixture,
  onLoadFixtureJson,
  warningThresholdKmh,
  onThresholdChange,
}: Props) {
  const [fixtureError, setFixtureError] = useState<string | null>(null);

  const handlePresetChange = (id: string) => {
    setFixtureError(null);
    const preset = getBuiltInFixtureById(id);
    if (preset && onLoadFixture) {
      onLoadFixture(preset);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onLoadFixtureJson) return;
    const text = await file.text();
    const res = onLoadFixtureJson(text);
    if (!res.ok) {
      setFixtureError(res.errors?.join("; ") ?? "Invalid route fixture JSON");
    } else {
      setFixtureError(null);
    }
  };

  const currentFixtureDesc =
    activeFixture?.description ??
    getBuiltInFixtureById(c.activeFixtureId)?.description ??
    "SYNTHETIC TEST DATA — not real Vietnamese map data.";

  return (
    <form className="panel" aria-label="Simulator controls" onSubmit={(e) => e.preventDefault()}>
      <h2>Simulator controls</h2>
      <p className="panel-note">All values are simulated. No real GPS or Bluetooth is used.</p>

      <SelectField<NavigationMode>
        id="mode"
        label="Navigation mode"
        value={c.mode}
        options={[
          { value: "TURN", label: "TURN" },
          { value: "MAP", label: "MAP" },
        ]}
        onChange={(mode) => onChange({ mode })}
      />

      <fieldset>
        <legend>Vietnamese scenario fixtures (synthetic)</legend>
        <div className="field">
          <label htmlFor="vn-preset">Synthetic route scenario</label>
          <select
            id="vn-preset"
            value={VN_ROUTE_FIXTURES.some((f) => f.id === c.activeFixtureId) ? c.activeFixtureId : VN_ROUTE_FIXTURES[0]!.id}
            onChange={(e) => handlePresetChange(e.target.value)}
          >
            {VN_ROUTE_FIXTURES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <p className="panel-note" data-testid="fixture-description">
          {currentFixtureDesc}
        </p>
        <div className="field">
          <label htmlFor="fixture-file">Load custom JSON fixture</label>
          <input id="fixture-file" type="file" accept=".json,application/json" onChange={(e) => void handleFileUpload(e)} />
        </div>
        {fixtureError && (
          <p className="feed-error" role="alert" data-testid="fixture-error">
            Fixture rejected: {fixtureError}
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Speed</legend>
        <RangeField id="speed" label="Current GPS speed" unit="km/h" min={0} max={160} value={c.speedKmh} disabled={c.autoSpeed} onChange={(speedKmh) => onChange({ speedKmh })} />
        <div className="field">
          <label htmlFor="auto-speed" className="check">
            <input id="auto-speed" type="checkbox" checked={c.autoSpeed} onChange={(e) => onChange({ autoSpeed: e.target.checked })} />
            Automatic speed simulation
          </label>
        </div>
        <div className="field">
          <label htmlFor="limit">Speed limit</label>
          <select id="limit" value={c.speedLimitKmh === null ? "unknown" : String(c.speedLimitKmh)} onChange={(e) => onChange({ speedLimitKmh: e.target.value === "unknown" ? null : Number(e.target.value) })}>
            {SPEED_LIMIT_OPTIONS.map((o) => (
              <option key={o ?? "unknown"} value={o === null ? "unknown" : String(o)}>
                {o === null ? "Unknown" : `${o} km/h`}
              </option>
            ))}
          </select>
        </div>
        <RangeField id="threshold" label="Warning threshold" prefix="+" unit="km/h" min={0} max={20} value={warningThresholdKmh} onChange={onThresholdChange} />
      </fieldset>

      <fieldset>
        <legend>Navigation</legend>
        <SelectField<SimulatorControls["turnDirection"]>
          id="turn"
          label="Next turn"
          value={c.turnDirection}
          options={TURN_DIRECTIONS.map((d) => ({ value: d, label: d }))}
          onChange={(turnDirection) => onChange({ turnDirection })}
        />
        <RangeField id="distance" label="Distance to next turn" unit="m" min={0} max={2000} step={10} value={c.distanceToTurnMeters} onChange={(distanceToTurnMeters) => onChange({ distanceToTurnMeters })} />
        <SelectField<SimulatorControls["routeStatus"]>
          id="route"
          label="Navigation"
          value={c.routeStatus}
          options={[
            { value: "ACTIVE", label: "ACTIVE" },
            { value: "INACTIVE", label: "INACTIVE" },
          ]}
          onChange={(routeStatus) => onChange({ routeStatus })}
        />
        <div className="field">
          <label htmlFor="route-available" className="check">
            <input id="route-available" type="checkbox" checked={c.routeAvailable} onChange={(e) => onChange({ routeAvailable: e.target.checked })} />
            Route geometry available
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Position (simulated)</legend>
        <RangeField id="heading" label="Heading" unit="°" min={0} max={359} value={c.headingDegrees} onChange={(headingDegrees) => onChange({ headingDegrees })} />
        <RangeField id="progress" label="Map position along demo route" unit="%" min={0} max={100} value={c.routeProgressPercent} onChange={(routeProgressPercent) => onChange({ routeProgressPercent })} />
      </fieldset>

      <fieldset>
        <legend>Link and freshness</legend>
        <SelectField<SimulatorControls["gpsStatus"]>
          id="gps"
          label="GPS status"
          value={c.gpsStatus}
          options={[
            { value: "ACTIVE", label: "ACTIVE" },
            { value: "LOST", label: "LOST" },
          ]}
          onChange={(gpsStatus) => onChange({ gpsStatus })}
        />
        <SelectField<SimulatorControls["bleStatus"]>
          id="ble"
          label="Simulated BLE connection"
          value={c.bleStatus}
          options={[
            { value: "CONNECTED", label: "CONNECTED" },
            { value: "DISCONNECTED", label: "DISCONNECTED" },
          ]}
          onChange={(bleStatus) => onChange({ bleStatus })}
        />
        <SelectField<SimulatorControls["limitFreshness"]>
          id="limit-freshness"
          label="Speed-limit data freshness"
          value={c.limitFreshness}
          options={[
            { value: "FRESH", label: "Fresh" },
            { value: "STALE", label: "Stale" },
          ]}
          onChange={(limitFreshness) => onChange({ limitFreshness })}
        />
        <SelectField<SimulatorControls["packetFreshness"]>
          id="packet-freshness"
          label="Navigation packet freshness"
          value={c.packetFreshness}
          options={[
            { value: "LIVE", label: "Live" },
            { value: "STALE", label: "Stale (old timestamp)" },
          ]}
          onChange={(packetFreshness) => onChange({ packetFreshness })}
        />
      </fieldset>

      <button type="button" className="reset" onClick={onReset}>
        Reset to default scenario
      </button>
    </form>
  );
}
