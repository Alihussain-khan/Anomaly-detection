"""
One time import of the aquaculture CSV into SQLite.

Run from the backend directory:
    python scripts/import.py
"""

import sqlite3
from pathlib import Path

import pandas as pd

CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "aquaculture.csv"
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "aquarium.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    water_temp REAL NOT NULL,
    air_temp REAL NOT NULL,
    ph REAL NOT NULL,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings (timestamp);
"""


def load_and_clean(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    df["timestamp"] = pd.to_datetime(df["timestamp"], format="mixed", utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)

    df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    df = df.rename(columns={"deviceId": "device_id"})
    df = df[["device_id", "water_temp", "air_temp", "ph", "timestamp"]]

    return df


def import_to_sqlite(df: pd.DataFrame, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        df.to_sql("readings", conn, if_exists="append", index=False)
        conn.commit()

        count = conn.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
        print(f"Imported {count} rows into {db_path}")

        first = conn.execute(
            "SELECT timestamp FROM readings ORDER BY timestamp ASC LIMIT 1"
        ).fetchone()[0]
        last = conn.execute(
            "SELECT timestamp FROM readings ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()[0]
        print(f"Time range: {first} to {last}")
    finally:
        conn.close()


if __name__ == "__main__":
    print(f"Reading {CSV_PATH}")
    data = load_and_clean(CSV_PATH)
    import_to_sqlite(data, DB_PATH)