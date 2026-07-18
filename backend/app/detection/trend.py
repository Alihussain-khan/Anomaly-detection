"""Rolling trend detection.

Flags sustained directional drift over a window of readings: either the
median of the second half of the window differing meaningfully from the
median of the first half, or a long run of consecutive moves in the same
direction. The median split (rather than a linear regression slope) is
what makes this robust to a single extreme point sitting in the window: a
lone spike shifts a mean or an OLS slope a lot but barely moves a median,
so a one-tick fault doesn't get misread as an extended trend for the next
WINDOW rows. This is deliberately different from spikes.py, which reacts to
a single large jump rather than a gradual trend.

Thresholds are set with roughly a 2x safety margin over the largest
median-diff seen on this tank's calibration and demo windows (excluding
rows where the fault value is the current reading), so ordinary sensor
noise doesn't trip it.
"""

from collections import deque

import numpy as np

WINDOW = 20
HALF = WINDOW // 2
MEDIAN_DIFF_THRESHOLDS = {
    "water_temp": 0.3,
    "air_temp": 0.15,
    "ph": 0.35,
}
RUN_LENGTH_THRESHOLD = 10


class TrendDetector:
    def __init__(self):
        self._windows = {field: deque(maxlen=WINDOW) for field in MEDIAN_DIFF_THRESHOLDS}
        self._run_direction = dict.fromkeys(MEDIAN_DIFF_THRESHOLDS, 0)
        self._run_length = dict.fromkeys(MEDIAN_DIFF_THRESHOLDS, 0)
        self._run_start_value = dict.fromkeys(MEDIAN_DIFF_THRESHOLDS)
        self._last_value = dict.fromkeys(MEDIAN_DIFF_THRESHOLDS)

    def check(self, row: dict) -> tuple[bool, str | None]:
        reasons = []

        for field, diff_threshold in MEDIAN_DIFF_THRESHOLDS.items():
            value = row[field]
            window = self._windows[field]
            window.append(value)

            last = self._last_value[field]
            if last is not None:
                direction = 1 if value > last else (-1 if value < last else 0)
                if direction != 0 and direction == self._run_direction[field]:
                    self._run_length[field] += 1
                else:
                    self._run_direction[field] = direction
                    self._run_length[field] = 1 if direction != 0 else 0
                    if direction != 0:
                        self._run_start_value[field] = last
            self._last_value[field] = value

            if len(window) >= WINDOW:
                arr = np.array(window)
                baseline = np.median(arr[:HALF])
                recent = np.median(arr[HALF:])
                median_diff = recent - baseline
                if abs(median_diff) > diff_threshold:
                    reasons.append(
                        f"{field} baseline {baseline:.3f} vs recent median {recent:.3f} "
                        f"(shifted {median_diff:+.3f} over the last {WINDOW} readings)"
                    )

            if self._run_length[field] >= RUN_LENGTH_THRESHOLD:
                direction_word = "up" if self._run_direction[field] > 0 else "down"
                start_value = self._run_start_value[field]
                reasons.append(
                    f"{field} moved {direction_word} for "
                    f"{self._run_length[field]} consecutive readings "
                    f"(from {start_value:.3f} to {value:.3f})"
                )

        if reasons:
            return True, "; ".join(reasons)
        return False, None
