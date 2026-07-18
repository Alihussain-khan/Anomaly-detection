/** Mirrors the backend WebSocket contract exactly - see backend/backend_guide.md. */

/** Shared between ReplayService and AquaChart so the visible chart window
 * can't drift out of sync between where it's collected and where it's drawn. */
export const CHART_WINDOW_SIZE = 20;

export type MetricKey = 'water_temp' | 'air_temp' | 'ph';

export const METRIC_KEYS: MetricKey[] = ['water_temp', 'air_temp', 'ph'];

export const METRIC_LABELS: Record<MetricKey, string> = {
  water_temp: 'water temp',
  air_temp: 'air temp',
  ph: 'ph',
};

export interface AnomalyFlags {
  threshold: boolean;
  threshold_detail: string | null;
  trend: boolean;
  trend_detail: string | null;
  spike: boolean;
  spike_detail: string | null;
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
  anomalies: AnomalyFlags;
}

export interface DoneMessage {
  type: 'done';
  total_readings: number;
  total_anomalies_flagged: number;
}

export type ReplayMessage = Reading | DoneMessage;

export function isAnomalous(reading: Reading): boolean {
  const a = reading.anomalies;
  return a.threshold || a.trend || a.spike || a.isolation_forest;
}

const DETECTOR_KEYS = ['threshold', 'trend', 'spike', 'isolation_forest'] as const;
export type DetectorKey = (typeof DETECTOR_KEYS)[number];

export function firedDetectors(reading: Reading): DetectorKey[] {
  return DETECTOR_KEYS.filter((key) => reading.anomalies[key]);
}

/**
 * The four anomaly flags aren't per-metric, only threshold/trend/spike carry
 * a free-text detail naming the field involved (e.g. "water_temp=-127.0
 * below minimum 0.0"). This recovers which line(s) a ripple/log entry should
 * attribute an anomaly to by matching metric names in those detail strings.
 * If only isolation_forest fired (a purely multivariate signal with no
 * single named field), all three metrics are implicated together, since the
 * anomaly is in how they combine, not in any one of them alone.
 */
export function anomalyMetrics(reading: Reading): MetricKey[] {
  const { anomalies } = reading;
  const detailText = [
    anomalies.threshold_detail,
    anomalies.trend_detail,
    anomalies.spike_detail,
  ]
    .filter((detail): detail is string => detail !== null)
    .join(' ');

  const named = METRIC_KEYS.filter((key) => detailText.includes(key));
  if (named.length > 0) {
    return named;
  }

  return anomalies.isolation_forest ? [...METRIC_KEYS] : [];
}
