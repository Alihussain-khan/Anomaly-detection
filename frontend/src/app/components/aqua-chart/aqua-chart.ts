import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { PlotlyModule } from 'angular-plotly.js';

import {
  MetricKey,
  Reading,
  anomalyMetrics,
  isAnomalous,
  sensorFaultMetrics,
} from '../../models/reading.model';

interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
}

const METRICS: readonly MetricConfig[] = [
  { key: 'water_temp', label: 'water temp', color: '#2ED9C3' },
  { key: 'air_temp', label: 'air temp', color: '#8FA9AC' },
  { key: 'ph', label: 'ph', color: '#4A7FA7' },
];

/** Fixed y-axis range per metric, sized to this tank's actual operating band
 * (not the full physical-sensor-fault range in reading.model.ts's
 * METRIC_BOUNDS - that's 0-40C/-10-50C/0-14pH, so wide that ordinary
 * sub-degree noise and even a multi-degree anomaly would be indistinguishable
 * from a flat line). Chosen from the real dataset's observed range with
 * headroom: water_temp sits at 24.7-26.0C, air_temp 19.1-22.1C, ph 5.6-7.1
 * (including the known single-sample glitch) - so each range below leaves
 * room for real anomaly-sized excursions (the Task 2 magnitude thresholds:
 * 1.0C / 0.5C / 0.35) without clipping, while keeping ordinary movement
 * clearly visible. A sensor fault's true value (e.g. -127) is still clamped
 * to whichever edge of this range it's nearest to, same idea as before, just
 * against this tighter range instead of the physical one. */
const DISPLAY_RANGE: Record<MetricKey, readonly [number, number]> = {
  water_temp: [20, 30],
  air_temp: [15, 25],
  ph: [5, 7.5],
};

// Mirror styles.css's --color-anomaly-amber / --color-sensor-fault-red:
// Plotly renders outside Angular's style pipeline, so these can't be read
// from a CSS custom property at draw time.
const ANOMALY_COLOR = '#FF9F4A';
const FAULT_COLOR = '#FF5C5C';
const GRID_COLOR = 'rgba(232, 241, 240, 0.12)';
const TICK_COLOR = 'rgba(232, 241, 240, 0.6)';

const PANEL_HEIGHT_PX = 220;

/** How often buffered readings are actually pushed into the Plotly traces -
 * deliberately decoupled from how often the `readings` input itself updates,
 * so the chart redraws at a steady, calm cadence even if the backend paces
 * delivery faster than this. */
const RENDER_INTERVAL_MS = 1500;

@Component({
  selector: 'app-aqua-chart',
  standalone: true,
  imports: [PlotlyModule],
  templateUrl: './aqua-chart.html',
  styleUrl: './aqua-chart.css',
})
export class AquaChart {
  readonly readings = input.required<Reading[]>();

  protected readonly metrics = METRICS;
  protected readonly config = { displayModeBar: false, responsive: true };
  protected readonly plotStyle = { width: '100%', height: `${PANEL_HEIGHT_PX}px` };

  /** The slice of `readings` actually drawn right now - only replaced once
   * every RENDER_INTERVAL_MS (plus immediately on the very first batch), see
   * the constructor. */
  private readonly rendered = signal<Reading[]>([]);
  private hasRenderedFirstBatch = false;

  private readonly dataByMetric = new Map(
    METRICS.map((metric) => [metric.key, computed(() => this.buildData(metric))] as const),
  );
  private readonly layoutByMetric = new Map(
    METRICS.map((metric) => [metric.key, computed(() => this.buildLayout(metric))] as const),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect(() => {
      const latest = this.readings();
      if (!this.hasRenderedFirstBatch && latest.length > 0) {
        // Draw the first batch immediately rather than waiting a full
        // render interval for the chart to show anything at all.
        this.hasRenderedFirstBatch = true;
        this.rendered.set(latest);
      }
    });

    if (typeof window !== 'undefined') {
      const id = window.setInterval(() => {
        this.rendered.set(this.readings());
      }, RENDER_INTERVAL_MS);
      destroyRef.onDestroy(() => window.clearInterval(id));
    }
  }

  protected dataFor(metric: MetricConfig): any[] {
    return this.dataByMetric.get(metric.key)!();
  }

  protected layoutFor(metric: MetricConfig): any {
    return this.layoutByMetric.get(metric.key)!();
  }

  private buildData(metric: MetricConfig): any[] {
    const readings = this.rendered();
    const [min, max] = DISPLAY_RANGE[metric.key];

    const lineX: string[] = [];
    const lineY: (number | null)[] = [];
    const anomalyX: string[] = [];
    const anomalyY: number[] = [];
    const faultX: string[] = [];
    const faultY: number[] = [];

    for (const reading of readings) {
      lineX.push(reading.timestamp);

      // sensor_fault is a whole-row flag (true if ANY field is out of
      // bounds), so a fault on water_temp alone must not also blank out
      // air_temp/ph on that same row - only break/mark the line for the
      // metric(s) actually named in the fault detail.
      const isFaultedHere = reading.sensor_fault && sensorFaultMetrics(reading).includes(metric.key);
      if (isFaultedHere) {
        // A fault's raw value is often physically nonsensical (e.g. -127) and
        // has no place on this display range, so it breaks the line (null)
        // rather than plotting a fake position on it. It's still shown, just
        // as a separate marker below, clamped to the nearest edge.
        lineY.push(null);
        const raw = reading[metric.key];
        faultX.push(reading.timestamp);
        faultY.push(raw < min ? min : raw > max ? max : raw);
        continue;
      }

      lineY.push(reading[metric.key]);
      if (isAnomalous(reading) && anomalyMetrics(reading).includes(metric.key)) {
        anomalyX.push(reading.timestamp);
        anomalyY.push(reading[metric.key]);
      }
    }

    // Plotly's date-axis autorange gets stuck (stops recalculating on later
    // react() calls) once a trace array mixes a growing trace with another
    // trace that stays permanently empty (x: [], y: []) across updates -
    // confirmed by direct reproduction against Plotly.js in isolation. The
    // anomaly/fault traces have no points for long stretches of a replay, so
    // they're only included here once they actually have something to show,
    // instead of always being present as empty placeholders.
    const traces: any[] = [
      {
        x: lineX,
        y: lineY,
        type: 'scatter',
        mode: 'lines',
        line: { color: metric.color, width: 1.5, shape: 'linear' },
        connectgaps: false,
        hoverinfo: 'x+y',
        showlegend: false,
      },
    ];

    if (anomalyX.length > 0) {
      traces.push({
        x: anomalyX,
        y: anomalyY,
        type: 'scatter',
        mode: 'markers',
        marker: { color: ANOMALY_COLOR, size: 8, symbol: 'circle' },
        hoverinfo: 'x+y',
        showlegend: false,
      });
    }

    if (faultX.length > 0) {
      traces.push({
        x: faultX,
        y: faultY,
        type: 'scatter',
        mode: 'markers',
        marker: { color: FAULT_COLOR, size: 9, symbol: 'x' },
        hoverinfo: 'x',
        showlegend: false,
      });
    }

    return traces;
  }

  private buildLayout(metric: MetricConfig): any {
    const [min, max] = DISPLAY_RANGE[metric.key];
    const readings = this.rendered();

    // Plotly's own date-axis autorange stops recalculating across
    // successive react() calls whenever some trace in the figure stops
    // changing between updates (confirmed by direct reproduction against
    // Plotly.js) - which happens routinely here, e.g. a single sensor fault
    // that never repeats leaves the fault marker trace fixed forever after.
    // Computing the x range ourselves from the current readings' own
    // timestamps every time sidesteps that entirely, the same way the fixed
    // y range already does.
    const xRange =
      readings.length > 0
        ? [readings[0].timestamp, readings[readings.length - 1].timestamp]
        : undefined;

    return {
      autosize: true,
      margin: { l: 44, r: 12, t: 8, b: 28 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      showlegend: false,
      transition: { duration: 0 },
      xaxis: {
        type: 'date',
        range: xRange,
        showgrid: true,
        gridcolor: GRID_COLOR,
        tickfont: { color: TICK_COLOR, size: 10 },
        zeroline: false,
        fixedrange: true,
      },
      yaxis: {
        range: [min, max],
        showgrid: true,
        gridcolor: GRID_COLOR,
        tickfont: { color: TICK_COLOR, size: 10 },
        zeroline: false,
        fixedrange: true,
      },
    };
  }
}
