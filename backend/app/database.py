"""SQLite access for the readings table."""

from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "aquarium.db"


async def fetch_readings_range(start_id: int, end_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, device_id, water_temp, air_temp, ph, timestamp "
            "FROM readings WHERE id BETWEEN ? AND ? ORDER BY id ASC",
            (start_id, end_id),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
