"""Combines the four detection layers behind one per-connection pipeline.

A fresh instance is created per WebSocket connection so each independent
replay gets its own rolling state and its own Isolation Forest calibration,
rather than sharing state across concurrent clients.

Detection results for the visible replay window are computed once, up
front, before any pacing/sending begins (see precompute()); the WebSocket
handler then just sends and sleeps. This keeps per-message pacing accurate
regardless of how long the underlying detectors take to run - notably
Isolation Forest, whose scoring is batched here for the same reason (see
isolation_forest.py).
"""

from .isolation_forest import IsolationForestDetector
from .spikes import SpikeDetector
from .thresholds import check_thresholds
from .trend import TrendDetector


class DetectionPipeline:
    def __init__(self):
        self._trend = TrendDetector()
        self._spike = SpikeDetector()
        self._isolation_forest = IsolationForestDetector()

    def warm_up(self, calibration_rows: list[dict]) -> None:
        """Prime rolling trend/spike state and the Isolation Forest
        training buffer on the calibration window, then fit the model once
        on the whole set, before the visible replay begins."""
        for row in calibration_rows:
            self._trend.check(row)
            self._spike.check(row)
            self._isolation_forest.observe(row)
        self._isolation_forest.fit()

    def precompute(self, rows: list[dict]) -> list[dict]:
        """Compute anomaly results for every row of the visible replay
        window, in order, ahead of the paced send loop."""
        threshold_results = [check_thresholds(row) for row in rows]
        trend_results = [self._trend.check(row) for row in rows]
        spike_results = [self._spike.check(row) for row in rows]
        if_results = self._isolation_forest.score_batch(rows)

        results = []
        for (threshold_flag, threshold_detail), (trend_flag, trend_detail), (
            spike_flag,
            spike_detail,
        ), (if_flag, if_detail) in zip(
            threshold_results, trend_results, spike_results, if_results
        ):
            any_anomaly = threshold_flag or trend_flag or spike_flag or if_flag
            results.append(
                {
                    "any_anomaly": any_anomaly,
                    "anomalies": {
                        "threshold": threshold_flag,
                        "threshold_detail": threshold_detail,
                        "trend": trend_flag,
                        "trend_detail": trend_detail,
                        "spike": spike_flag,
                        "spike_detail": spike_detail,
                        "isolation_forest": if_flag,
                        "isolation_forest_detail": if_detail,
                    },
                }
            )
        return results
