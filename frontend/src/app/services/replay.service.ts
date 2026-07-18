import { Injectable, computed, signal } from '@angular/core';

import {
  CHART_WINDOW_SIZE,
  DoneMessage,
  Reading,
  ReplayMessage,
  isAnomalous,
} from '../models/reading.model';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'done' | 'error';

/** The FastAPI backend from backend/, run separately via `uvicorn main:app --reload`. */
const BACKEND_WS_URL = 'ws://localhost:8000/ws/replay';

@Injectable({ providedIn: 'root' })
export class ReplayService {
  private socket: WebSocket | null = null;

  /** Most recent reading received while paused, not yet applied to `latest`/`window`. */
  private heldReading: Reading | null = null;

  readonly status = signal<ConnectionStatus>('idle');
  readonly latest = signal<Reading | null>(null);
  readonly window = signal<Reading[]>([]);
  readonly anomalyLog = signal<Reading[]>([]);
  readonly done = signal<DoneMessage | null>(null);
  readonly paused = signal(false);

  readonly anomalyCount = computed(() => this.anomalyLog().length);

  start(startRow?: number, endRow?: number): void {
    this.stop();

    this.latest.set(null);
    this.window.set([]);
    this.anomalyLog.set([]);
    this.done.set(null);
    this.paused.set(false);
    this.heldReading = null;
    this.status.set('connecting');

    const params = new URLSearchParams();
    if (startRow !== undefined) params.set('start_row', String(startRow));
    if (endRow !== undefined) params.set('end_row', String(endRow));
    const query = params.toString();
    const url = query ? `${BACKEND_WS_URL}?${query}` : BACKEND_WS_URL;

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.status.set('connected');
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ReplayMessage;

      if (message.type === 'reading') {
        if (isAnomalous(message)) {
          this.anomalyLog.update((log) => [message, ...log]);
        }
        if (this.paused()) {
          this.heldReading = message;
          return;
        }
        this.applyReading(message);
        return;
      }

      this.done.set(message);
      this.status.set('done');
    };

    socket.onerror = () => {
      this.status.set('error');
    };

    socket.onclose = () => {
      this.status.update((current) =>
        current === 'connecting' || current === 'connected' ? 'error' : current,
      );
    };
  }

  private applyReading(message: Reading): void {
    this.latest.set(message);
    this.window.update((current) => {
      const next = [...current, message];
      return next.length > CHART_WINDOW_SIZE ? next.slice(-CHART_WINDOW_SIZE) : next;
    });
  }

  /** Freezes the chart panels and numeric readout at their current reading. The
   * socket keeps streaming in the background and the anomaly log keeps growing;
   * only the most recent reading is held rather than applied, so nothing is
   * dropped but nothing new renders either until sync/resume. */
  pause(): void {
    this.paused.set(true);
  }

  /** Snaps the chart panels and numeric readout straight to the most recently
   * held reading and resumes live updates from there. Used both by the explicit
   * sync button and by resuming without syncing first - replaying the backlog
   * point by point has no value over just catching up to now. */
  sync(): void {
    if (this.heldReading) {
      this.applyReading(this.heldReading);
      this.heldReading = null;
    }
    this.paused.set(false);
  }

  stop(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
    this.socket = null;
  }
}
