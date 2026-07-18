import { DestroyRef, Component, effect, inject, input, signal } from '@angular/core';

import {
  MetricKey,
  Reading,
  anomalyMetrics,
  isAnomalous,
} from '../../models/reading.model';

interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
  /**
   * Chart-legibility band, not the backend's fault-detection thresholds.
   * Values outside this band are excluded from the dynamic axis range below
   * and clipped to its nearest edge, so a single extreme fault (e.g.
   * water_temp = -127) can't compress the other 59 points on screen into a
   * flat line or drag the axis back out to fit itself.
   */
  band: readonly [number, number];
}

const METRICS: readonly MetricConfig[] = [
  { key: 'water_temp', label: 'water temp', color: '#2ED9C3', band: [15, 30] },
  { key: 'air_temp', label: 'air temp', color: '#8FA9AC', band: [10, 30] },
  { key: 'ph', label: 'ph', color: '#4A7FA7', band: [4, 9] },
];

const WINDOW_SIZE = 60;
const CHART_WIDTH = 600;
const CHART_HEIGHT = 220;
const PADDING_Y = 14;
const RIPPLE_LIFETIME_MS = 1000;

/** How much headroom to add above/below the visible window's min/max before
 * scaling the axis to it, so the line doesn't hug the very top/bottom edge. */
const RANGE_PADDING_FRACTION = 0.15;

interface Point {
  x: number;
  y: number;
  clipped: boolean;
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

  protected readonly viewBox = `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`;
  protected readonly metrics = METRICS;

  protected readonly reducedMotion = signal(
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  protected readonly ripples = signal<RippleInstance[]>([]);

  /** x position for slot i, always relative to the fixed window size so the
   * chart fills in from the left during the first 30s rather than
   * prematurely stretching a handful of points across the full width. */
  private xFor(index: number): number {
    return (index / (WINDOW_SIZE - 1)) * CHART_WIDTH;
  }

  /** The y axis range to actually plot against: the min/max of whatever's
   * currently visible in the window (excluding band-clipped extremes, so a
   * fault value can't stretch the scale back out), padded so the line
   * doesn't touch the top/bottom edge. Recomputed on every call so it
   * tracks the window as it scrolls. Falls back to the full legibility band
   * if every visible point is currently clipped (or the window is empty). */
  private dynamicRangeFor(metric: MetricConfig): [number, number] {
    const [bandMin, bandMax] = metric.band;
    const visibleValues = this.readings()
      .map((reading) => reading[metric.key])
      .filter((value) => value >= bandMin && value <= bandMax);

    if (visibleValues.length === 0) {
      return [bandMin, bandMax];
    }

    const min = Math.min(...visibleValues);
    const max = Math.max(...visibleValues);
    const span = max - min;
    const padding = Math.max(span * RANGE_PADDING_FRACTION, (bandMax - bandMin) * 0.02);

    return [min - padding, max + padding];
  }

  private yFor(
    value: number,
    band: readonly [number, number],
    range: readonly [number, number],
  ): { y: number; clipped: boolean } {
    const [rangeMin, rangeMax] = range;
    const [bandMin, bandMax] = band;
    const clippedValue = clamp(value, rangeMin, rangeMax);
    const usableHeight = CHART_HEIGHT - PADDING_Y * 2;
    const fraction = (clippedValue - rangeMin) / (rangeMax - rangeMin);
    return {
      y: CHART_HEIGHT - PADDING_Y - fraction * usableHeight,
      clipped: value < bandMin || value > bandMax,
    };
  }

  protected pointsFor(metric: MetricConfig): Point[] {
    const range = this.dynamicRangeFor(metric);
    return this.readings().map((reading, index) => {
      const value = reading[metric.key];
      const { y, clipped } = this.yFor(value, metric.band, range);
      return { x: this.xFor(index), y, clipped };
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

  /** Instant color swap (no transition) used only under reduced motion, in
   * place of the ripple animation. */
  protected tipColorFor(metric: MetricConfig): string {
    const readings = this.readings();
    const latest = readings[readings.length - 1];
    if (
      this.reducedMotion() &&
      latest &&
      isAnomalous(latest) &&
      anomalyMetrics(latest).includes(metric.key)
    ) {
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

  protected colorForKey(key: MetricKey): string {
    return this.metrics.find((metric) => metric.key === key)?.color ?? '#ffffff';
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
