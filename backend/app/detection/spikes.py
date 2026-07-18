"""Point-to-point spike detection.

Flags a sudden jump between consecutive readings, using an adaptive rolling
standard deviation of recent deltas so the threshold reflects each metric's
own typical noise level rather than a fixed number. Complements trend.py,
which looks at sustained drift over a window instead of single-tick jumps.
"""

from collections import deque

DELTA_WINDOW = 30
Z_THRESHOLD = 6.0
MIN_STD = 1e-6
MIN_SAMPLES = 5

FIELDS = ("water_temp", "air_temp", "ph")


class SpikeDetector:
    def __init__(self):
        self._last_value = {field: None for field in FIELDS}
        self._deltas = {field: deque(maxlen=DELTA_WINDOW) for field in FIELDS}

    def check(self, row: dict) -> tuple[bool, str | None]:
        reasons = []

        for field in FIELDS:
            value = row[field]
            last = self._last_value[field]
            self._last_value[field] = value
            if last is None:
                continue

            delta = value - last
            deltas = self._deltas[field]

            if len(deltas) >= MIN_SAMPLES:
                mean = sum(deltas) / len(deltas)
                variance = sum((d - mean) ** 2 for d in deltas) / len(deltas)
                std = max(variance**0.5, MIN_STD)
                z = abs(delta - mean) / std
                if z > Z_THRESHOLD:
                    reasons.append(
                        f"{field} jumped from {last:.3f} to {value:.3f} "
                        f"(Δ{delta:+.3f}, {z:.1f} sigma vs recent norm)"
                    )

            deltas.append(delta)

        if reasons:
            return True, "; ".join(reasons)
        return False, None
