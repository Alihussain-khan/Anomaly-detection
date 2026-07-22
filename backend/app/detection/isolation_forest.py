"""Multivariate anomaly detection via Isolation Forest.

Historical replay data would make the model look artificially good if it
scored the exact rows it trained on, so calibration rows are only ever fed
in via observe() (buffered, never scored), followed by one explicit fit()
call once calibration completes (see pipeline.warm_up). The visible replay
window is then scored with score_batch(), which periodically refits on the
(capped) rolling buffer of everything seen so far, so it adapts rather than
staying frozen on the calibration slice alone.

Only fault-filtered rows ever reach observe()/score_batch() - the pipeline
excludes sensor faults (see thresholds.py) before calling either, so a fault
value never enters training data or a scored feature vector.

Each field contributes two features: the raw value and its deviation from
that field's own trailing 2-minute rolling mean (via rolling.py, the same
window used by deviation.py). The deviation feature is what lets this catch
"weird combined patterns" - e.g. all three fields drifting together in a way
no single field's rolling check would flag - rather than just re-deriving
what the raw values already show.

Scoring is done in per-refit-interval batches rather than one row at a
time: a single-sample decision_function() call pays sklearn's per-call
overhead (input validation, per-tree traversal) on every row, measured at
roughly 1ms per estimator per call - at N_ESTIMATORS=200 that's ~180ms per
row, a meaningful chunk of the 1s replay tick. Batching amortizes that
overhead across many rows at once (measured at well under 1ms/row for a
300-row batch) without changing which rows train which model version,
since batches are still processed strictly in id order and each one only
ever contains rows up to the next refit boundary.
"""

from collections import deque

import numpy as np
from sklearn.ensemble import IsolationForest

from .rolling import RollingMean, parse_timestamp

FIELDS = ("water_temp", "air_temp", "ph")
ROLLING_WINDOW_SECONDS = 120  # matches deviation.py's 2-minute window
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

MIN_DEVIATION_STD = 1e-6


class IsolationForestDetector:
    def __init__(self):
        self._buffer = deque(maxlen=BUFFER_CAP)
        self._model = None
        self._typical_low = None
        self._typical_high = None
        self._deviation_std = dict.fromkeys(FIELDS, MIN_DEVIATION_STD)
        self._rolling = {field: RollingMean(ROLLING_WINDOW_SECONDS) for field in FIELDS}

    def _vector(self, row: dict) -> list[float]:
        """Raw value plus deviation-from-rolling-mean for each field. Rolling
        state advances here (not in a separate step) so it stays continuous
        across observe() calibration rows and score_batch() replay rows,
        exactly like DeviationDetector's own window."""
        ts = parse_timestamp(row["timestamp"])
        deviations = []
        for field in FIELDS:
            baseline = self._rolling[field].baseline(ts)
            deviations.append(0.0 if baseline is None else row[field] - baseline)
        for field in FIELDS:
            self._rolling[field].add(ts, row[field])
        return [row[field] for field in FIELDS] + deviations

    def observe(self, row: dict) -> None:
        """Add a calibration row to the training buffer without scoring it."""
        self._buffer.append(self._vector(row))

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
        # Per-field spread of the deviation-from-rolling-mean feature across
        # calibration, used to judge "how unusual" a flagged row's deviation
        # is relative to what's normal FOR THAT FIELD - water_temp, air_temp
        # and ph move on very different scales, so a raw deviation magnitude
        # alone can't be compared across fields.
        deviation_columns = data[:, 3:6]
        for i, field in enumerate(FIELDS):
            self._deviation_std[field] = max(float(deviation_columns[:, i].std()), MIN_DEVIATION_STD)
        self._model = model

    def _explain(self, vector: list[float], score: float) -> str:
        """Names which field(s) actually drove a flag, instead of just
        naming the algorithm. Isolation Forest has no per-prediction
        feature importance, so this ranks each field's deviation-from-
        rolling-mean by how many calibration-typical standard deviations
        it sits at (a raw deviation can't be compared across fields, since
        water_temp/air_temp/ph move on very different scales) and reports
        the field(s) that stand out - two fields close together read as
        "moved together", one field far ahead of the rest reads alone."""
        deviations = dict(zip(FIELDS, vector[3:6]))
        z_scores = {field: abs(deviations[field]) / self._deviation_std[field] for field in FIELDS}
        ranked = sorted(FIELDS, key=lambda field: z_scores[field], reverse=True)
        top, second = ranked[0], ranked[1]

        def describe(field: str) -> str:
            return f"{field} {deviations[field]:+.3f} vs its 2-min average"

        if z_scores[second] >= 0.5 * z_scores[top]:
            pattern = f"{top} and {second} shifted together in an unusual combination ({describe(top)}, {describe(second)})"
        else:
            pattern = f"{top} shifted in an unusual way relative to the other readings ({describe(top)})"

        return (
            f"{pattern}; isolation score {score:.3f} "
            f"(typical calibration range {self._typical_low:.3f} to {self._typical_high:.3f})"
        )

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
                for score, vector in zip(scores, pending):
                    if score < 0:
                        detail = self._explain(vector, score)
                        results.append((True, detail))
                    else:
                        results.append((False, None))
            pending.clear()

        for row in rows:
            vector = self._vector(row)
            self._buffer.append(vector)
            pending.append(vector)
            seen_since_fit += 1
            if self._model is not None and seen_since_fit >= REFIT_INTERVAL:
                flush_pending()
                self.fit()
                seen_since_fit = 0

        flush_pending()
        return results
