"""Time-based rolling window helper shared by deviation.py and isolation_forest.py.

Windows are kept as a wall-clock duration rather than a sample count, so a
2-minute window stays 2 minutes' worth of readings regardless of the
device's actual sample cadence - if a production device samples faster or
slower than this tank's ~5 second cadence, the window adapts automatically
instead of silently covering a different amount of real time.
"""

from collections import deque
from datetime import datetime, timedelta


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class RollingMean:
    """Trailing time-window mean for a single field."""

    def __init__(self, window_seconds: float):
        self._window_seconds = window_seconds
        self._entries: deque[tuple[datetime, float]] = deque()
        self._sum = 0.0

    def baseline(self, ts: datetime) -> float | None:
        """Mean of whatever is currently in the window, before `ts` is added.

        Returns None if the window is empty (no history yet to compare against).
        """
        cutoff = ts - timedelta(seconds=self._window_seconds)
        while self._entries and self._entries[0][0] < cutoff:
            _, old_value = self._entries.popleft()
            self._sum -= old_value
        if not self._entries:
            return None
        return self._sum / len(self._entries)

    def add(self, ts: datetime, value: float) -> None:
        self._entries.append((ts, value))
        self._sum += value
