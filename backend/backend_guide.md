# Backend Build Guide

## Context

This is a personal aquarium water quality monitoring project. The stack is FastAPI for the backend and Angular for the frontend, but this guide covers backend only. Frontend comes later as a separate pass.

Data is already imported. There is a SQLite database at backend/data/aquarium.db with a single table called readings, holding 40872 real sensor rows from a fish tank, columns are id, device_id, water_temp, air_temp, ph, timestamp. It has already been verified as correct: row count, time range, and the presence of 465 rows where water_temp equals negative 127, which is a real sensor disconnect fault captured in the raw data.

There is also an earlier proof of concept in this project that used simulated data and already implements four layers of anomaly detection: threshold checks, rolling trend detection, spike detection, and Isolation Forest for multivariate detection. Find that existing code first and adapt it rather than writing detection logic from scratch. Find it by reading the current files sitting in the project directory, do not go digging through git history or old commits to locate it. The goal of this phase is to point that existing detection logic at the real SQLite data through a live style replay, not to redesign the detection approach.

## Goal for this phase

Build a FastAPI service that:
1. Replays the 40872 rows from aquarium.db in order, one row every 500 milliseconds, over a WebSocket connection
2. Runs every row through the existing detection pipeline as it is replayed
3. Sends each row plus its detection results to any connected WebSocket client
4. Stops cleanly at the end of the data, sending a completion message, no looping back to the start

## Important constraint, please follow this exactly

Do not add any special case rule for water_temp equal to negative 127. That value is only known because we inspected the CSV ahead of time, and hard coding a rule for it would be answering the exam with the answer key in hand. It must be caught, if it is caught, purely by the same general threshold and Isolation Forest logic used for everything else. If it is not reliably caught, that is useful signal to report back, not something to patch around with a special rule.

## Suggested structure

```
backend/
  app/
    main.py              FastAPI app, WebSocket route
    database.py          SQLite connection and query helpers
    replay.py            Reads rows in order, paces them at 500ms
    detection/           Existing detection logic, adapted, not rewritten
      thresholds.py
      trend.py
      spikes.py
      isolation_forest.py
  data/
    aquaculture.csv
    aquarium.db
  scripts/
    import_data.py
```

Exact file names are a suggestion, keep whatever structure the existing detection code already uses if it does not match this.

## Demo mode

Playing all 40872 rows at 500 milliseconds per row takes about 5 hours and 40 minutes, far too long for a demo. Add a configurable start row and end row for replay, defaulting to a 1000 row window, rows 2400 through 3399 by id. At 500 milliseconds per row that is about 8 minutes and 20 seconds. This specific window was chosen because it contains 27 occurrences of the water_temp equal to negative 127 fault, spread fairly evenly across the whole window, rather than clustered in one place, so the demo shows detection working repeatedly rather than once.

The Isolation Forest calibration step described below still needs real data to train on before the demo window starts. Use rows 1400 through 2399, the 1000 rows immediately before the demo window, as the calibration set. Train on those rows quietly, sending nothing to the client, then begin the visible replay at row 2400 with the model already warmed up. Note that 5 of those 1000 calibration rows also happen to be water_temp negative 127 faults, so the calibration data is not perfectly clean, this is expected and fine, do not go filtering the calibration set to remove them.

Keep the start row, end row, and calibration row count as configuration values rather than hard coded numbers buried in the replay logic, so the window can be changed later without touching core code.

## Detection model warm up

Isolation Forest needs data to train on before it can usefully flag outliers. Since this is historical data being replayed rather than a genuinely live unknown feed, use this approach unless there is a strong reason to do otherwise:
1. Take the first slice of rows, for example the first 500 to 1000 readings, and use them to fit an initial model, treating this as a calibration window rather than something shown as scored output
2. Begin sending detection results, including Isolation Forest flags, once the calibration window is complete
3. Periodically refit the model as more data accumulates during replay, for example every few thousand rows, so it adapts rather than staying frozen on the first slice alone

This avoids training the model on the exact same rows it is later asked to score, which would make the detection look better than it would on genuinely new data.

## WebSocket message format

One JSON message per reading, sent as the row is replayed:

```json
{
  "type": "reading",
  "id": 12345,
  "device_id": "esp8266_C5CBC1",
  "water_temp": 25.5,
  "air_temp": 20.1,
  "ph": 5.97,
  "timestamp": "2019-05-23T19:10:38.396000Z",
  "anomalies": {
    "threshold": false,
    "trend": false,
    "spike": false,
    "isolation_forest": false
  }
}
```

Each of the four detection flags should be true or false, plus include enough detail for a human to understand why, for example which bound was crossed for a threshold flag. Keep the extra detail in the response, just do not let it replace the plain boolean flags, since the frontend will likely key off those directly later.

Final message once replay reaches the end of the table:

```json
{
  "type": "done",
  "total_readings": 40872,
  "total_anomalies_flagged": 0
}
```

Fill in the real total_anomalies_flagged count based on however many rows tripped at least one detector.

## Replay behavior

1. Query readings ordered by id ascending, not by timestamp, since id already reflects the correct sort order from import and is a cleaner key to page through
2. Pace at 500 milliseconds per row, using the tick interval itself, not the gaps between the original timestamps, those gaps are irregular and would make the demo feel uneven
3. Run through the table exactly once per connection, then send the done message and close cleanly, no looping
4. Multiple WebSocket clients connecting should each get their own independent replay from the start, rather than sharing one global replay position

## Out of scope for this phase

1. No frontend work of any kind
2. No cross device logic, there is only one device in this dataset
3. No special casing for any specific sensor value, including negative 127
4. No changes to the SQLite schema or the import script, both are already done and verified

## How to confirm this phase is working

1. Connect a simple WebSocket client, for example using websocat or a short Python script with the websockets library, and confirm readings arrive roughly every 500 milliseconds
2. Confirm exactly 40872 reading messages arrive before the done message
3. Confirm the done message's total_readings equals 40872
4. Spot check that at least some of the 465 rows where water_temp is negative 127 get flagged by at least one detector, without ever having told the code to look for that specific value
