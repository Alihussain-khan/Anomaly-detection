import { Component, computed, inject } from '@angular/core';

import { AnomalyLog } from './components/anomaly-log/anomaly-log';
import { AquaChart } from './components/aqua-chart/aqua-chart';
import { ControlDeck } from './components/control-deck/control-deck';
import { NumericReadout } from './components/numeric-readout/numeric-readout';
import { ReplayService } from './services/replay.service';

const STATUS_LABELS = {
  idle: 'idle',
  connecting: 'connecting',
  connected: 'streaming',
  done: 'complete',
  error: 'disconnected',
} as const;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ControlDeck, AquaChart, NumericReadout, AnomalyLog],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly replay = inject(ReplayService);

  protected readonly statusLabel = computed(() => STATUS_LABELS[this.replay.status()]);

  /** The pause button doubles as an unsynced resume - jumping straight to the
   * latest held reading either way, since there's no value in dramatizing
   * catching up on a backlog point by point. */
  protected togglePause(): void {
    if (this.replay.paused()) {
      this.replay.sync();
    } else {
      this.replay.pause();
    }
  }
}
