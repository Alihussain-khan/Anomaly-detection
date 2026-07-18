import { Component, input } from '@angular/core';

import { MetricKey, Reading, anomalyMetrics, isAnomalous } from '../../models/reading.model';

interface MetricDisplay {
  key: MetricKey;
  label: string;
  color: string;
  decimals: number;
}

const METRIC_DISPLAYS: MetricDisplay[] = [
  { key: 'water_temp', label: 'water temp', color: '#2ED9C3', decimals: 1 },
  { key: 'air_temp', label: 'air temp', color: '#8FA9AC', decimals: 1 },
  { key: 'ph', label: 'ph', color: '#4A7FA7', decimals: 2 },
];

@Component({
  selector: 'app-numeric-readout',
  standalone: true,
  templateUrl: './numeric-readout.html',
  styleUrl: './numeric-readout.css',
})
export class NumericReadout {
  readonly latest = input<Reading | null>(null);
  readonly anomalyCount = input(0);

  protected readonly metrics = METRIC_DISPLAYS;

  protected valueFor(metric: MetricDisplay): string {
    const reading = this.latest();
    return reading ? reading[metric.key].toFixed(metric.decimals) : '--';
  }

  protected isAnomalousFor(metric: MetricDisplay): boolean {
    const reading = this.latest();
    return !!reading && isAnomalous(reading) && anomalyMetrics(reading).includes(metric.key);
  }
}
