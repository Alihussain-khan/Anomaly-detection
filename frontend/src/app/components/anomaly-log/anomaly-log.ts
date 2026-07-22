import { Component, computed, input } from '@angular/core';

import {
  DetectorKey,
  METRIC_LABELS,
  Reading,
  anomalyMetrics,
  firedDetectors,
  sensorFaultMetrics,
} from '../../models/reading.model';

interface LogRow {
  id: number;
  time: string;
  detail: string;
  reason: string;
}

const DETECTOR_LABELS: Record<DetectorKey, string> = {
  deviation: 'threshold + persistence',
  isolation_forest: 'isolation forest',
};

const DECIMALS: Record<'water_temp' | 'air_temp' | 'ph', number> = {
  water_temp: 1,
  air_temp: 1,
  ph: 2,
};

/** Renders either the anomaly log or the sensor-fault log - same list shape,
 * different source of metrics/labels, kept as one component since faults and
 * anomalies must never share a row (see Reading.sensor_fault vs .anomalies)
 * but do share every bit of rendering logic otherwise. */
@Component({
  selector: 'app-anomaly-log',
  standalone: true,
  templateUrl: './anomaly-log.html',
  styleUrl: './anomaly-log.css',
})
export class AnomalyLog {
  /** Newest-first, as produced by ReplayService. */
  readonly entries = input<Reading[]>([]);
  readonly kind = input<'anomaly' | 'fault'>('anomaly');
  readonly emptyMessage = input('No anomalies yet.');

  protected readonly rows = computed<LogRow[]>(() =>
    this.entries().map((reading) => {
      const time = new Date(reading.timestamp).toISOString().substring(11, 19);

      if (this.kind() === 'fault') {
        const metrics = sensorFaultMetrics(reading);
        const detail =
          metrics.map((key) => `${METRIC_LABELS[key]} ${reading[key].toFixed(DECIMALS[key])}`).join(', ') ||
          (reading.sensor_fault_detail ?? '');
        return { id: reading.id, time, detail, reason: 'sensor fault' };
      }

      const metrics = anomalyMetrics(reading);
      const detail = metrics
        .map((key) => `${METRIC_LABELS[key]} ${reading[key].toFixed(DECIMALS[key])}`)
        .join(', ');

      // The detector name alone ("isolation forest") doesn't explain
      // anything to someone looking at values that seem unremarkable -
      // show the actual free-text reason each detector produced instead.
      const reason =
        [reading.anomalies.deviation_detail, reading.anomalies.isolation_forest_detail]
          .filter((text): text is string => text !== null)
          .join('; ') ||
        firedDetectors(reading)
          .map((key) => DETECTOR_LABELS[key])
          .join(', ');
      return { id: reading.id, time, detail, reason };
    }),
  );
}
