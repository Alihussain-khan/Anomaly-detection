"""Fixed-threshold-plus-persistence deviation detection.

Replaces the earlier trend/spike pair with a single rule per parameter: flag
a reading only when it moves past a fixed magnitude threshold AND stays past
that threshold for at least PERSISTENCE_SAMPLES consecutive readings. The
magnitude check alone is not enough - a single-sample sensor glitch (seen in
this tank's data as a one-tick pH jump that reverts on the very next sample)
clears the magnitude bar but never the persistence bar, so it's correctly
ignored as noise rather than flagged as a real event.

The baseline each reading is compared against is the rolling mean of the
trailing WINDOW_SECONDS of *this parameter's own* readings (via RollingMean),
not a fixed number - so the detector self-adjusts to wherever the parameter
has actually been sitting for the last couple of minutes, only firing on
genuine departures from that recent norm.

Sensor-fault rows (see thresholds.py) must never reach this detector: the
pipeline filters them out before calling check(), so a fault value never
enters the rolling baseline or gets compared against it.
"""

from .rolling import RollingMean, parse_timestamp

WINDOW_SECONDS = 120  # 2 minutes

MAGNITUDE_THRESHOLDS = {
    "water_temp": 1.0,
    "air_temp": 0.5,
    "ph": 0.35,
}

PERSISTENCE_SAMPLES = 2  # must breach on this many consecutive readings, not revert on the next one


class DeviationDetector:
    def __init__(self):
        self._rolling = {field: RollingMean(WINDOW_SECONDS) for field in MAGNITUDE_THRESHOLDS}
        self._breach_streak = dict.fromkeys(MAGNITUDE_THRESHOLDS, 0)

    def check(self, row: dict) -> tuple[bool, str | None]:
        reasons = []
        ts = parse_timestamp(row["timestamp"])

        for field, threshold in MAGNITUDE_THRESHOLDS.items():
            value = row[field]
            rolling = self._rolling[field]
            baseline = rolling.baseline(ts)

            if baseline is None:
                self._breach_streak[field] = 0
            else:
                delta = value - baseline
                if abs(delta) > threshold:
                    self._breach_streak[field] += 1
                else:
                    self._breach_streak[field] = 0

                if self._breach_streak[field] >= PERSISTENCE_SAMPLES:
                    minutes = WINDOW_SECONDS / 60
                    reasons.append(
                        f"{field} moved {delta:+.3f} vs the {minutes:g}-minute rolling average "
                        f"{baseline:.3f} (now {value:.3f}, sustained for "
                        f"{self._breach_streak[field]} consecutive readings)"
                    )

            rolling.add(ts, value)

        if reasons:
            return True, "; ".join(reasons)
        return False, None
