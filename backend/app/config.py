"""Replay window configuration.

Playing all 40872 rows at 1s each takes about 11 hours 20 minutes, far too
long for a demo. By default the replay is restricted to a fixed window
instead of the full table. Change these values, not the replay or pipeline
logic, to move the window or resize the warm-up.
"""

# Demo window: rows 2400-3399 contain 27 water_temp = -127 faults spread
# fairly evenly across the range, so detection visibly fires more than once.
DEFAULT_START_ROW = 2400
DEFAULT_END_ROW = 3399

# Rows immediately before the start row, used to quietly warm up detector
# state (rolling trend/spike windows, Isolation Forest training buffer)
# before the visible replay begins. 5 of these 1000 rows are also -127
# faults; that's expected and the set is not filtered to remove them.
CALIBRATION_ROW_COUNT = 1000

TICK_SECONDS = 1.0
