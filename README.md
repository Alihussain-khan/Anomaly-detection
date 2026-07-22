# Aqua Watch

A live-replay dashboard for aquarium water quality data: a FastAPI backend replays
40,872 real sensor readings from a fish tank over a WebSocket, running each one
through a three-layer anomaly detection pipeline, while an Angular + Plotly.js
frontend streams the result into live charts, a numeric readout, and two
separate logs (real anomalies vs. broken sensor readings).

It's built around one real dataset quirk: this tank's sensor occasionally reports
`water_temp = -127.0` when it disconnects — 465 times across the full table. The
whole point of the detection design here is to treat that as a **sensor fault**,
never as an anomaly, while still catching genuine water-quality problems that
don't look like a broken sensor at all.

## Quick start

**Backend** (FastAPI, Python 3.11+):

```bash
cd backend
python -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/fastapi dev main.py
# or: ./venv/bin/uvicorn main:app --reload
```

Runs on `http://localhost:8000`. The SQLite database (`backend/data/aquarium.db`)
is already populated and tracked in the repo; `backend/scripts/import.py` is
what originally built it from `aquaculture.csv` and only needs to be re-run if
the DB is ever recreated from scratch.

**Frontend** (Angular 21):

```bash
cd frontend
npm install
npm start   # ng serve, http://localhost:4200
```

Open the app, expand the control deck (top right), pick a start/end row (or
leave the defaults — see below), and hit **Start replay**.

## What you're looking at

The demo defaults to rows **2400–3399** of the readings table specifically
because that window contains 27 of the `-127` sensor faults spread across it,
so a short demo run actually shows fault handling more than once. Rows
1400–2399 (the 1000 immediately before) are used to quietly warm up the
detectors' rolling state and Isolation Forest's calibration before the visible
replay begins, so nothing scores against a cold model.

Each connection gets its own fresh `DetectionPipeline` instance (see
`backend/app/detection/pipeline.py`) — independent rolling state and
Isolation Forest calibration per client, no shared global replay position.

## The detection pipeline

Three layers, run in this specific order, in `backend/app/detection/pipeline.py`:

### 1. Sensor fault gate (`thresholds.py`)

A static physical-plausibility check per field — not tuned to this tank's
normal operating range, just "is this value physically possible at all":

| field | valid range |
|---|---|
| `water_temp` | 0 – 40 °C |
| `air_temp` | -10 – 50 °C |
| `ph` | 0 – 14 |

Anything outside this is reported as a **sensor fault**, not an anomaly, and
is filtered out *before* it ever reaches the other two layers — it never
enters a rolling baseline, never trains Isolation Forest, and never gets
scored by it. This is what keeps a `-127` reading from silently poisoning
every other detector's sense of "normal."

### 2. Deviation detector (`deviation.py`) — the primary trigger

A fixed magnitude threshold plus a persistence requirement, per field,
against a genuinely time-based (not sample-count-based) rolling average:

| field | magnitude threshold | rolling window |
|---|---|---|
| `water_temp` | 1.0 °C | 2 minutes |
| `air_temp` | 0.5 °C | 2 minutes |
| `ph` | 0.35 | 2 minutes |

A reading only fires if it's past the threshold **and** stays past it for at
least 2 consecutive samples. The persistence check exists specifically
because of a real glitch in this data: at `2019-05-24 13:05:56`, `ph` jumps to
7.12 for exactly one sample and reverts on the very next one, while
`water_temp`/`air_temp` stay completely flat — a magnitude-only check would
flag that as real; persistence correctly lets it pass as noise.

This detector logs *why* it fired in plain language, e.g.:

> `water_temp moved -2.824 vs the 2-minute rolling average 25.704 (now 22.880, sustained for 2 consecutive readings)`

### 3. Isolation Forest (`isolation_forest.py`) — secondary, optional layer

A multivariate model that catches "weird combined patterns" no single field's
threshold would notice — e.g. three fields drifting together in a way that's
individually sub-threshold but jointly unusual. Trained only on fault-filtered
data, using **six features** per row: each field's raw value plus its own
deviation from its trailing 2-minute rolling mean.

Isolation Forest has no built-in per-prediction feature importance, so when it
fires, `_explain()` ranks each field's deviation by how many calibration-typical
standard deviations it sits at (comparing raw magnitudes across `water_temp` /
`air_temp` / `ph` wouldn't mean anything, since they move on very different
scales) and names the field(s) responsible, e.g.:

> `air_temp and ph shifted together in an unusual combination (air_temp -0.049 vs its 2-min average, ph +0.120 vs its 2-min average); isolation score -0.025 (typical calibration range 0.064 to 0.227)`

It periodically refits on the accumulated buffer (every 300 rows in the demo
window) so it adapts rather than staying frozen on the calibration slice.

### Validating the pipeline

`backend/scripts/validate_detection.py` runs the deviation detector against
the **full real dataset** and checks three things:

1. Zero false positives on ordinary sensor noise across all 40,872 rows.
2. The single-sample pH glitch above is correctly ignored.
3. A synthetic sustained failure (water_temp steps down 3°C and holds) is
   correctly flagged.

Run it with `./venv/bin/python scripts/validate_detection.py` from `backend/`.

## WebSocket contract

`ws://localhost:8000/ws/replay?start_row=2400&end_row=3399` (both params optional,
default to the values above). One `reading` message per row, paced at
`config.TICK_SECONDS` (1 per second) regardless of the original timestamp
gaps, then one final `done` message:

```json
{
  "type": "reading",
  "id": 2494,
  "device_id": "esp8266_C5CBC1",
  "water_temp": 25.63,
  "air_temp": 20.56,
  "ph": 5.944469,
  "timestamp": "2019-05-23T05:58:23.655000Z",
  "sensor_fault": false,
  "sensor_fault_detail": null,
  "anomalies": {
    "deviation": false,
    "deviation_detail": null,
    "isolation_forest": true,
    "isolation_forest_detail": "air_temp and ph shifted together in an unusual combination (...)"
  }
}
```

```json
{ "type": "done", "total_readings": 1000, "total_anomalies_flagged": 9, "total_sensor_faults": 27 }
```

`sensor_fault` is a **separate, whole-row flag** from `anomalies` — a fault
row's `anomalies` are always false, and a real anomaly row's `sensor_fault` is
always false. They're mutually exclusive by construction.

## Frontend notes

- **Chart** (`aqua-chart.ts`): Plotly.js, one panel per metric. The y-axis is
  fixed per metric to a range sized for this tank's real operating band
  (`water_temp` 20–30 °C, `air_temp` 15–25 °C, `ph` 5–7.5) rather than the much
  wider physical fault-bounds above, so ordinary movement is actually visible.
  The x-axis range is computed explicitly from the visible readings' own
  timestamps every render rather than left to Plotly's autorange — its
  autorange silently stops recalculating across `react()` calls once any
  trace in the figure stops changing between updates (e.g. a sensor fault
  that fires once and never again), which otherwise freezes the whole chart.
- **Line breaks**: a sensor fault only breaks *that metric's* line (plotted as
  `null`) — a `water_temp`-only fault doesn't blank out `air_temp`/`ph` on the
  same row. The fault's true value is still shown as a separate marker,
  clamped to the nearest axis edge, since a `-127` has no sensible position on
  a 20–30 axis.
- **Render throttling**: incoming readings are buffered and only pushed into
  the chart every 1.5s, decoupled from how fast the backend actually sends
  data, so it doesn't visibly jitter.
- **Two separate logs**: `ReplayService` keeps `anomalyLog` and
  `sensorFaultLog` as distinct signals, rendered by two instances of the same
  `AnomalyLog` component (`kind="anomaly"` / `kind="fault"`) — a fault must
  never show up mixed into the anomaly log or vice versa.
- **Anomaly log detail**: shows the actual `deviation_detail` /
  `isolation_forest_detail` text from the backend, not just the detector's
  name — an Isolation Forest flag needs its reasoning spelled out, since the
  raw values alone often look unremarkable.

## Project structure

```
backend/
  main.py                        FastAPI app, the /ws/replay route
  app/
    config.py                    Demo window, calibration size, tick rate
    database.py                  SQLite access
    replay.py                    Calibration fetch + paced delivery
    detection/
      pipeline.py                Wires the three layers together per connection
      thresholds.py              Layer 1: sensor fault gate
      deviation.py                Layer 2: magnitude + persistence (primary trigger)
      isolation_forest.py        Layer 3: multivariate, secondary/optional
      rolling.py                 Shared time-based rolling-mean helper
  scripts/
    import.py                    One-time CSV -> SQLite import
    validate_detection.py        Validates deviation.py against the real dataset
  data/
    aquaculture.csv, aquarium.db

frontend/
  src/app/
    app.ts / app.html            Top-level layout
    services/replay.service.ts   WebSocket connection, reading buffers, logs
    models/reading.model.ts      Backend contract types + shared helpers
    components/
      control-deck/              Start/stop, row range inputs
      numeric-readout/           Live current values
      anomaly-log/               Anomaly log AND sensor-fault log (same component)
      aqua-chart/                Plotly.js live charts
```

## Design decisions worth knowing about

- **Why sensor faults are gated first, not just another detector**: an early
  version treated a `-127` fault as one of four equal "anomaly" signals. That
  meant it could enter rolling averages and Isolation Forest training data,
  quietly warping what those detectors considered "normal." Gating faults out
  before anything else touches them fixes this at the source.
- **Why deviation replaced the older trend/spike detectors**: those were
  overly sensitive to ordinary sensor noise. A fixed threshold plus a
  persistence requirement, against a time-based (not sample-count) rolling
  window, is both simpler to reason about and self-explanatory in its log
  output.
- **Why Isolation Forest stays secondary**: it's good at catching subtle joint
  drift across all three fields, but a bare "isolation forest" label with no
  explanation reads as a bug to anyone looking at values that seem normal.
  Making it explain which field(s) it thinks moved together, and by how much,
  is what makes a legitimate-but-subtle flag look intentional instead of broken.
