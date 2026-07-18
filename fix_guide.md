# Fix Guide: Anomaly Detail and Chart Sensitivity

Two real gaps found while actually watching the demo run, one backend, one frontend.

## Backend fix, anomaly detail needs real numbers

Right now anomaly messages only say which detector fired, for example spike, with no indication of what was actually compared. Every detector already has to compute something internally to decide a flag is warranted, the spike detector compares a new reading against a recent one, the trend detector compares against a rolling baseline, the threshold detector compares against a fixed bound. That comparison is happening already, it just is not being reported.

Update each detector in app/detection to include the actual numbers behind its decision in the detail it returns, not just true or false. At minimum:

- Spike detector: the previous value it compared against, the new value, and the size of the jump between them
- Trend detector: the rolling baseline value it compared against and how far the new reading deviated from it
- Threshold detector: which bound was crossed and by how much
- Isolation Forest: this one is harder to reduce to a single comparison, since it is multivariate, reporting the raw anomaly score relative to the calibration set's typical range is reasonable here rather than trying to name one cause

This detail should travel over the WebSocket message alongside the existing boolean flags, do not replace the booleans, add readable detail next to them.

## Frontend fix, dynamic axis scaling per metric

The chart currently likely scales each metric's axis against a fixed band, matching the same normal range used for the water temp clipping rule. This flattens real small movements, air temp only moves across about 3 degrees in the entire dataset, so genuine spikes in air temp barely show up against a much wider fixed scale.

Change each metric's y axis to scale dynamically against the actual visible 60 point window, not a fixed band:

1. For each metric, take the min and max of the values currently visible in the scrolling window, excluding any value already clipped for being outside the normal band, since including a clipped extreme would stretch the scale right back out and recreate the same flattening problem
2. Add roughly 10 to 20 percent padding above and below that range, so the line does not touch the very top or bottom edge of the chart
3. Recompute this range as the window scrolls, so the axis continuously reflects whatever the recent data actually looks like, rather than staying fixed for the whole session
4. The clipping rule from the original guide still applies on top of this, a genuinely out of band value like negative 127 still clips to the edge of whatever this dynamic range currently is, it does not get to stretch the axis to fit itself

## Why both matter together

A visible spike with no explanation is not much better than an invisible spike. Fixing only the chart without the log detail means you can see something happened but not what, fixing only the log without the chart means you can read what happened but the chart itself stays uninformative. Both should ship together.

## How to confirm this is fixed

1. Trigger a spike in the demo run and confirm the anomaly log entry names the previous value, new value, and the jump size, not just the word spike
2. Confirm the trend and threshold entries similarly show real numbers, not just the detector name
3. Watch the air temp line specifically during a normal stretch of the demo and confirm small real fluctuations are now visible as actual movement in the line, not a flat plateau
4. Confirm the negative 127 fault still clips correctly and does not stretch the axis out when it occurs
