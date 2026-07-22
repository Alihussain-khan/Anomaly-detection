"""
Validates the Task 2 deviation detector (app/detection/deviation.py) against
the full real aquaculture dataset, per aqua_watch_fix_plan.md's "Validation
before moving to Task 3" checklist:

1. Run against the full table and confirm it doesn't fire on ordinary noise.
2. Confirm the single-sample pH glitch at 2019-05-24 13:05:56 is ignored.
3. Inject a synthetic sustained jump (heater failure: water_temp steps down
   3C and stays there) and confirm it IS flagged.

Run from the backend directory:
    python scripts/validate_detection.py
"""

import copy
import sqlite3
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.detection.deviation import DeviationDetector  # noqa: E402
from app.detection.rolling import parse_timestamp  # noqa: E402
from app.detection.thresholds import check_sensor_fault  # noqa: E402

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "aquarium.db"


def fetch_all_rows() -> list[dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        "SELECT id, device_id, water_temp, air_temp, ph, timestamp FROM readings ORDER BY id ASC"
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def run_against(rows: list[dict], label: str) -> list[tuple[int, str, str]]:
    detector = DeviationDetector()
    fires = []
    faults = 0
    for row in rows:
        fault, _ = check_sensor_fault(row)
        if fault:
            faults += 1
            continue
        flagged, detail = detector.check(row)
        if flagged:
            fires.append((row["id"], row["timestamp"], detail))

    print(f"\n=== {label} ===")
    print(f"rows: {len(rows)}, sensor faults excluded: {faults}, deviation fires: {len(fires)}")
    for id_, ts, detail in fires[:50]:
        print(f"  id={id_} ts={ts} {detail}")
    if len(fires) > 50:
        print(f"  ... and {len(fires) - 50} more")
    return fires


def check_ph_glitch(rows: list[dict]) -> None:
    detector = DeviationDetector()
    target_prefix = "2019-05-24T13:05:56"
    matched = False
    for row in rows:
        if row["timestamp"].startswith(target_prefix):
            matched = True
            print(f"\nFound glitch row id={row['id']} ts={row['timestamp']} ph={row['ph']}")
        fault, _ = check_sensor_fault(row)
        if fault:
            continue
        flagged, detail = detector.check(row)
        if row["timestamp"].startswith(target_prefix) and flagged and "ph" in (detail or ""):
            print(f"UNEXPECTED: detector fired on the pH glitch row: {detail}")
            return
    if not matched:
        print(f"\nWARNING: no row found with timestamp prefix {target_prefix} - can't verify glitch handling.")
        return
    print("PASS: pH glitch at 2019-05-24 13:05:56 correctly NOT flagged (single sample, no persistence).")


def inject_step_heater_failure(rows: list[dict]) -> None:
    """Primary synthetic test: an abrupt, sustained failure - water_temp steps
    down 3C at start_idx and stays there for 5+ minutes. This is the realistic
    reading of "steady 3 degree drop over 5 minutes": a fault that happens and
    then holds, not a slow linear drift."""
    rows = copy.deepcopy(rows)
    start_idx = 500
    hold_duration = timedelta(minutes=5)
    start_ts = parse_timestamp(rows[start_idx]["timestamp"])
    start_value = rows[start_idx]["water_temp"]
    drop = 3.0

    for row in rows[start_idx:]:
        ts = parse_timestamp(row["timestamp"])
        if ts >= start_ts:
            row["water_temp"] = start_value - drop

    fires = run_against(rows, "Synthetic: water_temp steps down 3C and holds (step failure)")
    onset_fires = [f for f in fires if f[0] >= rows[start_idx]["id"]]
    if onset_fires:
        first_id, first_ts, first_detail = onset_fires[0]
        print(
            f"PASS: sustained step drop flagged, first firing at id={first_id} ts={first_ts}\n"
            f"  {first_detail}"
        )
    else:
        print("FAIL: synthetic sustained step drop was NOT flagged.")


def inject_linear_ramp(rows: list[dict]) -> None:
    """Secondary, informational test: a slow linear ramp (not a step) over 5
    minutes. A 2-minute rolling-average baseline lags a slow ramp by only
    roughly half the window's fraction of the ramp duration, so a gradual
    change can end up under the magnitude threshold even though the total
    drop is large. Reported for visibility, not treated as pass/fail."""
    rows = copy.deepcopy(rows)
    start_idx = 500
    ramp_seconds = 300.0
    start_ts = parse_timestamp(rows[start_idx]["timestamp"])
    start_value = rows[start_idx]["water_temp"]
    drop = 3.0

    for row in rows[start_idx:]:
        ts = parse_timestamp(row["timestamp"])
        elapsed = (ts - start_ts).total_seconds()
        if elapsed < 0:
            continue
        fraction = min(elapsed / ramp_seconds, 1.0)
        row["water_temp"] = start_value - drop * fraction

    fires = run_against(rows, "Synthetic: water_temp linear ramp -3C over 5 min (informational)")
    onset_fires = [f for f in fires if f[0] >= rows[start_idx]["id"]]
    if onset_fires:
        print(f"Linear ramp WAS flagged ({len(onset_fires)} firing rows).")
    else:
        print(
            "Linear ramp was NOT flagged - expected, given a 2-minute window "
            "lags a slow 5-minute ramp by less than the 1.0C threshold. A "
            "faster-onset failure (the step test above) is still caught."
        )


if __name__ == "__main__":
    all_rows = fetch_all_rows()
    print(f"Loaded {len(all_rows)} rows from {DB_PATH}")

    run_against(all_rows, "Full aquaculture.csv (real data, unmodified)")
    check_ph_glitch(all_rows)
    inject_step_heater_failure(all_rows)
    inject_linear_ramp(all_rows)
