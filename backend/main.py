import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app import config
from app.database import fetch_readings_range
from app.detection.pipeline import DetectionPipeline
from app.replay import fetch_calibration_rows, paced

app = FastAPI()


@app.get("/")
def read_root():
    return {"status": "ok", "service": "aquarium-anomaly-detection"}


@app.websocket("/ws/replay")
async def ws_replay(
    websocket: WebSocket,
    start_row: int = config.DEFAULT_START_ROW,
    end_row: int = config.DEFAULT_END_ROW,
):
    await websocket.accept()
    pipeline = DetectionPipeline()

    calibration_rows = await fetch_calibration_rows(start_row)
    await asyncio.to_thread(pipeline.warm_up, calibration_rows)

    demo_rows = await fetch_readings_range(start_row, end_row)
    results = await asyncio.to_thread(pipeline.precompute, demo_rows)

    total_readings = 0
    total_anomalies = 0
    total_sensor_faults = 0

    try:
        async for row, result in paced(zip(demo_rows, results)):
            total_readings += 1
            if result["any_anomaly"]:
                total_anomalies += 1
            if result["sensor_fault"]:
                total_sensor_faults += 1

            await websocket.send_json(
                {
                    "type": "reading",
                    "id": row["id"],
                    "device_id": row["device_id"],
                    "water_temp": row["water_temp"],
                    "air_temp": row["air_temp"],
                    "ph": row["ph"],
                    "timestamp": row["timestamp"],
                    "sensor_fault": result["sensor_fault"],
                    "sensor_fault_detail": result["sensor_fault_detail"],
                    "anomalies": result["anomalies"],
                }
            )

        await websocket.send_json(
            {
                "type": "done",
                "total_readings": total_readings,
                "total_anomalies_flagged": total_anomalies,
                "total_sensor_faults": total_sensor_faults,
            }
        )
        await websocket.close()
    except WebSocketDisconnect:
        pass