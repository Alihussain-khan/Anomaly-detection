"""Multivariate anomaly detection via Isolation Forest.

Historical replay data would make the model look artificially good if it
scored the exact rows it trained on, so calibration rows are only ever fed
in via observe() (buffered, never scored), followed by one explicit fit()
call once calibration completes (see pipeline.warm_up). The visible replay
window is then scored with score_batch(), which periodically refits on the
(capped) rolling buffer of everything seen so far, so it adapts rather than
staying frozen on the calibration slice alone.

Scoring is done in per-refit-interval batches rather than one row at a
time: a single-sample decision_function() call pays sklearn's per-call
overhead (input validation, per-tree traversal) on every row, measured at
roughly 1ms per estimator per call - at N_ESTIMATORS=200 that's ~180ms per
row, more than the entire 500ms replay tick. Batching amortizes that
overhead across many rows at once (measured at well under 1ms/row for a
300-row batch) without changing which rows train which model version,
since batches are still processed strictly in id order and each one only
ever contains rows up to the next refit boundary.
"""

from collections import deque

import numpy as np
from sklearn.ensemble import IsolationForest

FEATURES = ("water_temp", "air_temp", "ph")
BUFFER_CAP = 5000

# The demo replay window is only 1000 rows, much shorter than the "every
# few thousand rows" refit cadence that makes sense for the full table, so
# this is set low enough to actually trigger a couple of refits within it.
REFIT_INTERVAL = 300

# contamination="auto" derives its cutoff from the original Isolation
# Forest paper's fixed offset (-0.5), which on this tank's low-variance,
# tightly clustered readings flagged the majority of normal rows. An
# explicit low contamination assumes anomalies are rare (a stable aquarium
# should look stable) and keeps the false-positive rate on ordinary
# readings low without missing genuine outliers.
CONTAMINATION = 0.005
N_ESTIMATORS = 200


class IsolationForestDetector:
    def __init__(self):
        self._buffer = deque(maxlen=BUFFER_CAP)
        self._model = None
        self._typical_low = None
        self._typical_high = None

    def observe(self, row: dict) -> None:
        """Add a calibration row to the training buffer without scoring it."""
        self._buffer.append([row[field] for field in FEATURES])

    def fit(self) -> None:
        data = np.array(self._buffer)
        model = IsolationForest(
            n_estimators=N_ESTIMATORS, contamination=CONTAMINATION, random_state=42
        )
        model.fit(data)
        # The typical range of scores the fitted model assigns to the data it
        # was just trained on, used to give the raw score of a flagged row
        # some context (how far outside "normal" it is) since a bare score
        # like -0.02 means nothing on its own.
        calibration_scores = model.decision_function(data)
        self._typical_low = float(np.percentile(calibration_scores, 5))
        self._typical_high = float(np.percentile(calibration_scores, 95))
        self._model = model

    def score_batch(self, rows: list[dict]) -> list[tuple[bool, str | None]]:
        """Score rows in id order, refitting on the accumulated buffer
        every REFIT_INTERVAL rows. Each pending chunk is scored in one
        batched call against whichever model was current for that chunk."""
        results: list[tuple[bool, str | None]] = []
        pending: list[list[float]] = []
        seen_since_fit = 0

        def flush_pending():
            if not pending:
                return
            if self._model is None:
                results.extend((False, None) for _ in pending)
            else:
                scores = self._model.decision_function(np.array(pending))
                for score in scores:
                    if score < 0:
                        detail = (
                            f"multivariate outlier (isolation score {score:.3f}, "
                            f"typical calibration range {self._typical_low:.3f} to "
                            f"{self._typical_high:.3f})"
                        )
                        results.append((True, detail))
                    else:
                        results.append((False, None))
            pending.clear()

        for row in rows:
            vector = [row[field] for field in FEATURES]
            self._buffer.append(vector)
            pending.append(vector)
            seen_since_fit += 1
            if self._model is not None and seen_since_fit >= REFIT_INTERVAL:
                flush_pending()
                self.fit()
                seen_since_fit = 0

        flush_pending()
        return results
