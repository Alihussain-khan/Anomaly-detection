"""Static, physically-plausible bounds per sensor channel.

These are sanity bounds on what the physical quantity can plausibly be
(water is liquid, pH is 0-14), not bounds tuned to this tank's observed
operating range. Anything wildly outside them is impossible, regardless of
what specific fault produced it - this is the sensor-fault gate: rows that
fail this check are broken readings, not anomalies, and never reach the
deviation or Isolation Forest detectors (see pipeline.py).
"""

BOUNDS = {
    "water_temp": (0.0, 40.0),
    "air_temp": (-10.0, 50.0),
    "ph": (0.0, 14.0),
}


def check_sensor_fault(row: dict) -> tuple[bool, str | None]:
    violations = []
    for field, (low, high) in BOUNDS.items():
        value = row[field]
        if value < low:
            violations.append(f"{field}={value} below minimum {low} (by {low - value:.3f})")
        elif value > high:
            violations.append(f"{field}={value} above maximum {high} (by {value - high:.3f})")

    if violations:
        return True, "; ".join(violations)
    return False, None
