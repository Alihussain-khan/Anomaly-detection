import { Injectable, computed, signal } from '@angular/core';

import { DoneMessage, Reading, ReplayMessage, isAnomalous } from '../models/reading.model';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'done' | 'error';

/** The FastAPI backend from backend/, run separately via `uvicorn main:app --reload`. */
const BACKEND_WS_URL = 'ws://localhost:8000/ws/replay';

/** Chart shows only the most recent slice; the full history lives in anomalyLog. */
const CHART_WINDOW_SIZE = 60;

@Injectable({ providedIn: 'root' })
export class ReplayService {
  private socket: WebSocket | null = null;

  readonly status = signal<ConnectionStatus>('idle');
  readonly latest = signal<Reading | null>(null);
  readonly window = signal<Reading[]>([]);
  readonly anomalyLog = signal<Reading[]>([]);
  readonly done = signal<DoneMessage | null>(null);

  readonly anomalyCount = computed(() => this.anomalyLog().length);

  start(startRow?: number, endRow?: number): void {
    this.stop();

    this.latest.set(null);
    this.window.set([]);
    this.anomalyLog.set([]);
    this.done.set(null);
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
        this.latest.set(message);
        this.window.update((current) => {
          const next = [...current, message];
          return next.length > CHART_WINDOW_SIZE ? next.slice(-CHART_WINDOW_SIZE) : next;
        });
        if (isAnomalous(message)) {
          this.anomalyLog.update((log) => [message, ...log]);
        }
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
