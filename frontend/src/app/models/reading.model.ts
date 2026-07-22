/** Mirrors the backend WebSocket contract exactly - see backend/backend_guide.md
 * and backend/app/detection/pipeline.py. */

export type MetricKey = 'water_temp' | 'air_temp' | 'ph';

export const METRIC_KEYS: MetricKey[] = ['water_temp', 'air_temp', 'ph'];

export const METRIC_LABELS: Record<MetricKey, string> = {
  water_temp: 'water temp',
  air_temp: 'air temp',
  ph: 'ph',
};

/** Physically-plausible bounds per channel - mirrors backend/app/detection/thresholds.py
 * BOUNDS exactly. Anything outside these is a sensor fault, not a real reading. Also used
 * as the chart's fixed axis range (see aqua-chart.ts). */
export const METRIC_BOUNDS: Record<MetricKey, readonly [number, number]> = {
  water_temp: [0.0, 40.0],
  air_temp: [-10.0, 50.0],
  ph: [0.0, 14.0],
};

/** True anomaly signals only - a sensor fault is reported separately (see
 * Reading.sensor_fault) and is never one of these. */
export interface AnomalyFlags {
  deviation: boolean;
  deviation_detail: string | null;
  isolation_forest: boolean;
  isolation_forest_detail: string | null;
}

export interface Reading {
  type: 'reading';
  id: number;
  device_id: string;
  water_temp: number;
  air_temp: number;
  ph: number;
  timestamp: string;
  sensor_fault: boolean;
  sensor_fault_detail: string | null;
  anomalies: AnomalyFlags;
}

export interface DoneMessage {
  type: 'done';
  total_readings: number;
  total_anomalies_flagged: number;
  total_sensor_faults: number;
}

export type ReplayMessage = Reading | DoneMessage;

export function isAnomalous(reading: Reading): boolean {
  const a = reading.anomalies;
  return a.deviation || a.isolation_forest;
}

export function isSensorFault(reading: Reading): boolean {
  return reading.sensor_fault;
}

const DETECTOR_KEYS = ['deviation', 'isolation_forest'] as const;
export type DetectorKey = (typeof DETECTOR_KEYS)[number];

export function firedDetectors(reading: Reading): DetectorKey[] {
  return DETECTOR_KEYS.filter((key) => reading.anomalies[key]);
}

/**
 * Both deviation_detail and isolation_forest_detail carry a free-text detail
 * naming the field(s) involved (e.g. "water_temp moved -2.82 vs the
 * 2-minute rolling average...", or "water_temp and ph shifted together in
 * an unusual combination..."). This recovers which line(s) a marker/log
 * entry should attribute an anomaly to by matching metric names in those
 * strings. Only if NEITHER detail names a field do all three metrics get
 * implicated together, as a last-resort fallback.
 */
export function anomalyMetrics(reading: Reading): MetricKey[] {
  const { anomalies } = reading;
  const detailText = [anomalies.deviation_detail, anomalies.isolation_forest_detail]
    .filter((detail): detail is string => detail !== null)
    .join(' ');

  const named = METRIC_KEYS.filter((key) => detailText.includes(key));
  if (named.length > 0) {
    return named;
  }

  return anomalies.deviation || anomalies.isolation_forest ? [...METRIC_KEYS] : [];
}

/** Same idea as anomalyMetrics, but for the sensor-fault detail string
 * (e.g. "water_temp=-127.0 below minimum 0.0 (by 127.000)"). */
export function sensorFaultMetrics(reading: Reading): MetricKey[] {
  const detail = reading.sensor_fault_detail ?? '';
  return METRIC_KEYS.filter((key) => detail.includes(key));
}
