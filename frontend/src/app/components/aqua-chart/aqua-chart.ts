import { DestroyRef, Component, WritableSignal, effect, inject, input, signal } from '@angular/core';

import {
  CHART_WINDOW_SIZE,
  MetricKey,
  Reading,
  anomalyMetrics,
  isAnomalous,
} from '../../models/reading.model';

interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
  decimals: number;
  /** Floor for the axis padding, so a window of near-identical readings
   * doesn't collapse toward a zero-height range. */
  minPadding: number;
}

const METRICS: readonly MetricConfig[] = [
  { key: 'water_temp', label: 'water temp', color: '#2ED9C3', decimals: 1, minPadding: 0.3 },
  { key: 'air_temp', label: 'air temp', color: '#8FA9AC', decimals: 1, minPadding: 0.3 },
  { key: 'ph', label: 'ph', color: '#4A7FA7', decimals: 2, minPadding: 0.05 },
];

const CHART_WIDTH = 600;
const PANEL_HEIGHT = 220;
const PADDING_TOP = 32;
const PADDING_BOTTOM = 18;
const RIPPLE_LIFETIME_MS = 1000;

/** How much headroom to add above/below a metric's visible min/max before
 * scaling the axis to it, so the line doesn't hug the very top/bottom edge. */
const RANGE_PADDING_FRACTION = 0.15;

interface Point {
  x: number;
  y: number;
  anomalous: boolean;
  value: number;
}

interface RippleInstance {
  id: number;
  metric: MetricKey;
  cx: number;
  cy: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

@Component({
  selector: 'app-aqua-chart',
  standalone: true,
  templateUrl: './aqua-chart.html',
  styleUrl: './aqua-chart.css',
})
export class AquaChart {
  readonly readings = input.required<Reading[]>();

  protected readonly viewBox = `0 0 ${CHART_WIDTH} ${PANEL_HEIGHT}`;
  protected readonly metrics = METRICS;

  protected readonly reducedMotion = signal(
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  protected readonly ripples = signal<RippleInstance[]>([]);

  /** Each metric's current axis range, held in state rather than recomputed
   * every tick. Only replaced when an incoming non-anomalous value actually
   * falls outside it (see the effect below), then the panel eases smoothly
   * into the new range via the same CSS transition already used for point
   * motion, instead of the axis visibly jittering on every single update. */
  private readonly ranges = new Map<MetricKey, WritableSignal<readonly [number, number]>>(
    METRICS.map((metric) => [metric.key, signal<readonly [number, number]>([0, 0])]),
  );

  /** x position for slot i, always relative to the fixed window size so the
   * chart fills in from the left during the first few seconds rather than
   * prematurely stretching a handful of points across the full width. */
  private xFor(index: number): number {
    return (index / (CHART_WINDOW_SIZE - 1)) * CHART_WIDTH;
  }

  private rangeFor(metric: MetricConfig): readonly [number, number] {
    return this.ranges.get(metric.key)!();
  }

  private isAnomalousFor(metric: MetricConfig, reading: Reading): boolean {
    return isAnomalous(reading) && anomalyMetrics(reading).includes(metric.key);
  }

  /** Normal readings plot proportionally within the current range, at full
   * resolution. An anomalous reading never gets a proportional position at
   * all, it pins to whichever edge of the range it breached (or the nearer
   * edge, if the anomaly wasn't a literal breach of this axis) - a -127
   * fault and a hypothetical +9000 fault render identically, both just
   * touch the same edge, since the point is to show a breach happened, not
   * to represent the magnitude of an invalid reading. */
  private yFor(value: number, range: readonly [number, number], anomalous: boolean): number {
    const [rangeMin, rangeMax] = range;
    const usableHeight = PANEL_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
    let fraction: number;

    if (anomalous) {
      if (value >= rangeMax) {
        fraction = 1;
      } else if (value <= rangeMin) {
        fraction = 0;
      } else {
        fraction = rangeMax - value <= value - rangeMin ? 1 : 0;
      }
    } else {
      fraction = clamp((value - rangeMin) / (rangeMax - rangeMin), 0, 1);
    }

    return PANEL_HEIGHT - PADDING_BOTTOM - fraction * usableHeight;
  }

  protected pointsFor(metric: MetricConfig): Point[] {
    const range = this.rangeFor(metric);
    return this.readings().map((reading, index) => {
      const value = reading[metric.key];
      const anomalous = this.isAnomalousFor(metric, reading);
      const y = this.yFor(value, range, anomalous);
      return { x: this.xFor(index), y, anomalous, value };
    });
  }

  protected pathFor(metric: MetricConfig): string {
    const points = this.pointsFor(metric);
    if (points.length === 0) {
      return '';
    }
    return points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' ');
  }

  protected tipFor(metric: MetricConfig): Point | null {
    const points = this.pointsFor(metric);
    return points.length > 0 ? points[points.length - 1] : null;
  }

  protected ripplesFor(metric: MetricConfig): RippleInstance[] {
    return this.ripples().filter((ripple) => ripple.metric === metric.key);
  }

  protected glowFilterId(metric: MetricConfig): string {
    return `aqua-glow-${metric.key}`;
  }

  /** Places each value label on whichever side of the line its neighbors
   * are NOT on, so the label never sits on top of the line itself: a local
   * peak (both neighbors lower on screen, i.e. larger y) clears its label
   * above, a local valley clears below. Ties (flat/monotonic stretches)
   * fall back to alternating by index, same as before. */
  protected labelYFor(point: Point, index: number, points: readonly Point[]): number {
    const prev = points[index - 1];
    const next = points[index + 1];
    const neighborY = prev && next ? (prev.y + next.y) / 2 : (prev ?? next ?? point).y;

    const above =
      neighborY === point.y ? index % 2 === 0 : neighborY > point.y;
    return point.y + (above ? -11 : 17);
  }

  /** Anomalous points label in the same amber used for anomalies everywhere
   * else in the app (numeric readout, anomaly log), so a fault is easy to
   * spot in the numbers, not just by its pinned position on the line. */
  protected labelColorFor(metric: MetricConfig, point: Point): string {
    return point.anomalous ? 'var(--color-anomaly-amber)' : metric.color;
  }

  /** Instant color swap (no transition) used only under reduced motion, in
   * place of the ripple animation. */
  protected tipColorFor(metric: MetricConfig): string {
    const readings = this.readings();
    const latest = readings[readings.length - 1];
    if (this.reducedMotion() && latest && this.isAnomalousFor(metric, latest)) {
      return 'var(--color-anomaly-amber)';
    }
    return metric.color;
  }

  private nextRippleId = 0;
  private lastSeenReadingId: number | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);

    if (typeof window !== 'undefined') {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onChange = (event: MediaQueryListEvent) => this.reducedMotion.set(event.matches);
      media.addEventListener('change', onChange);
      destroyRef.onDestroy(() => media.removeEventListener('change', onChange));
    }

    effect(() => {
      const readings = this.readings();
      for (const metric of METRICS) {
        const visibleValues = readings
          .filter((reading) => !this.isAnomalousFor(metric, reading))
          .map((reading) => reading[metric.key]);

        if (visibleValues.length === 0) {
          continue;
        }

        const rangeSignal = this.ranges.get(metric.key)!;
        const [currentMin, currentMax] = rangeSignal();
        const outOfRange = visibleValues.some((value) => value < currentMin || value > currentMax);
        if (!outOfRange) {
          continue;
        }

        const min = Math.min(...visibleValues);
        const max = Math.max(...visibleValues);
        const span = max - min;
        const padding = Math.max(span * RANGE_PADDING_FRACTION, metric.minPadding);
        rangeSignal.set([min - padding, max + padding]);
      }
    });

    effect(() => {
      const readings = this.readings();
      const latest = readings[readings.length - 1];
      if (!latest || latest.id === this.lastSeenReadingId) {
        return;
      }
      this.lastSeenReadingId = latest.id;

      if (!isAnomalous(latest) || this.reducedMotion()) {
        return;
      }

      const targets = anomalyMetrics(latest);
      const newRipples: RippleInstance[] = [];
      for (const metric of this.metrics) {
        if (!targets.includes(metric.key)) {
          continue;
        }
        const tip = this.tipFor(metric);
        if (tip) {
          newRipples.push({ id: this.nextRippleId++, metric: metric.key, cx: tip.x, cy: tip.y });
        }
      }
      if (newRipples.length > 0) {
        this.ripples.update((current) => [...current, ...newRipples]);
      }
    });
  }

  protected colorFor(metric: MetricConfig): string {
    return metric.color;
  }

  /** CSS `d` property syntax (progressive enhancement over the `d`
   * attribute): browsers that support animating it get a smooth ease
   * between points; others just render the attribute with no transition. */
  protected cssPathFor(metric: MetricConfig): string {
    const path = this.pathFor(metric);
    return path ? `path("${path}")` : 'none';
  }

  protected removeRipple(id: number): void {
    this.ripples.update((current) => current.filter((ripple) => ripple.id !== id));
  }

  protected readonly rippleLifetimeMs = RIPPLE_LIFETIME_MS;
}
