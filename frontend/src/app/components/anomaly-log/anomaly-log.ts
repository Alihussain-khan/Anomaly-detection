import { Component, computed, input } from '@angular/core';

import {
  DetectorKey,
  METRIC_LABELS,
  Reading,
  anomalyMetrics,
  firedDetectors,
} from '../../models/reading.model';

interface LogRow {
  id: number;
  time: string;
  detail: string;
  detectors: string;
}

const DETECTOR_LABELS: Record<DetectorKey, string> = {
  threshold: 'threshold',
  trend: 'trend',
  spike: 'spike',
  isolation_forest: 'isolation forest',
};

const DECIMALS: Record<'water_temp' | 'air_temp' | 'ph', number> = {
  water_temp: 1,
  air_temp: 1,
  ph: 2,
};

@Component({
  selector: 'app-anomaly-log',
  standalone: true,
  templateUrl: './anomaly-log.html',
  styleUrl: './anomaly-log.css',
})
export class AnomalyLog {
  /** Newest-first, as produced by ReplayService. */
  readonly entries = input<Reading[]>([]);

  protected readonly rows = computed<LogRow[]>(() =>
    this.entries().map((reading) => {
      const metrics = anomalyMetrics(reading);
      const time = new Date(reading.timestamp).toISOString().substring(11, 19);
      const detail = metrics
        .map((key) => `${METRIC_LABELS[key]} ${reading[key].toFixed(DECIMALS[key])}`)
        .join(', ');
      const detectors = firedDetectors(reading)
        .map((key) => DETECTOR_LABELS[key])
        .join(', ');
      return { id: reading.id, time, detail, detectors };
    }),
  );
}
