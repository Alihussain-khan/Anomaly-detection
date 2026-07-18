"""Fetches the calibration window and paces delivery of already-computed
items at a fixed tick interval, rather than the original timestamp gaps
(those are irregular and would make the replay feel uneven).

Detection results are computed ahead of time (see
detection.pipeline.DetectionPipeline.precompute) rather than per item as
it's sent, so the only thing happening in the paced loop is sending and
sleeping - keeping the delivery cadence accurate regardless of how long
detection takes to run.
"""

import asyncio
from collections.abc import AsyncIterator, Iterable

from . import config
from .database import fetch_readings_range


async def fetch_calibration_rows(start_row: int) -> list[dict]:
    """Rows immediately before start_row, used to quietly warm up detector
    state before the visible replay begins."""
    calibration_end = start_row - 1
    calibration_start = max(1, calibration_end - config.CALIBRATION_ROW_COUNT + 1)
    if calibration_start > calibration_end:
        return []
    return await fetch_readings_range(calibration_start, calibration_end)


async def paced(items: Iterable) -> AsyncIterator:
    for item in items:
        yield item
        await asyncio.sleep(config.TICK_SECONDS)
