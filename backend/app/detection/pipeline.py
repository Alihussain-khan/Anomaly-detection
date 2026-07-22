"""Combines the sensor-fault gate and two anomaly layers behind one
per-connection pipeline.

A fresh instance is created per WebSocket connection so each independent
replay gets its own rolling state and its own Isolation Forest calibration,
rather than sharing state across concurrent clients.

Sensor faults (physically impossible readings, see thresholds.py) are
checked first and gate everything downstream: a fault row is reported as a
fault, not an anomaly, and is never fed to the deviation detector's rolling
baseline or the Isolation Forest, in training or inference. This runs the
same way in warm_up() and precompute() so a fault can't quietly poison
either detector's state through the calibration window either.

Detection results for the visible replay window are computed once, up
front, before any pacing/sending begins (see precompute()); the WebSocket
handler then just sends and sleeps. This keeps per-message pacing accurate
regardless of how long the underlying detectors take to run - notably
Isolation Forest, whose scoring is batched here for the same reason (see
isolation_forest.py).
"""

from .deviation import DeviationDetector
from .isolation_forest import IsolationForestDetector
from .thresholds import check_sensor_fault


class DetectionPipeline:
    def __init__(self):
        self._deviation = DeviationDetector()
        self._isolation_forest = IsolationForestDetector()

    def warm_up(self, calibration_rows: list[dict]) -> None:
        """Prime the deviation detector's rolling baseline and the
        Isolation Forest training buffer on the calibration window (skipping
        sensor faults), then fit the model once, before the visible replay
        begins."""
        for row in calibration_rows:
            fault, _ = check_sensor_fault(row)
            if fault:
                continue
            self._deviation.check(row)
            self._isolation_forest.observe(row)
        self._isolation_forest.fit()

    def precompute(self, rows: list[dict]) -> list[dict]:
        """Compute detection results for every row of the visible replay
        window, in order, ahead of the paced send loop. Sensor-fault rows are
        excluded from the clean_rows batch sent to the deviation detector and
        Isolation Forest, then every row's result is reassembled in original
        order."""
        fault_flags: list[tuple[bool, str | None]] = []
        clean_rows = []
        clean_indices = []
        for i, row in enumerate(rows):
            fault, fault_detail = check_sensor_fault(row)
            fault_flags.append((fault, fault_detail))
            if not fault:
                clean_rows.append(row)
                clean_indices.append(i)

        deviation_results = [self._deviation.check(row) for row in clean_rows]
        if_results = self._isolation_forest.score_batch(clean_rows)

        deviation_full: list[tuple[bool, str | None]] = [(False, None)] * len(rows)
        if_full: list[tuple[bool, str | None]] = [(False, None)] * len(rows)
        for idx, deviation_result, if_result in zip(clean_indices, deviation_results, if_results):
            deviation_full[idx] = deviation_result
            if_full[idx] = if_result

        results = []
        for (fault_flag, fault_detail), (deviation_flag, deviation_detail), (
            if_flag,
            if_detail,
        ) in zip(fault_flags, deviation_full, if_full):
            any_anomaly = deviation_flag or if_flag
            results.append(
                {
                    "any_anomaly": any_anomaly,
                    "sensor_fault": fault_flag,
                    "sensor_fault_detail": fault_detail,
                    "anomalies": {
                        "deviation": deviation_flag,
                        "deviation_detail": deviation_detail,
                        "isolation_forest": if_flag,
                        "isolation_forest_detail": if_detail,
                    },
                }
            )
        return results
