import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { ReplayService } from '../../services/replay.service';

@Component({
  selector: 'app-control-deck',
  standalone: true,
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatIconModule],
  templateUrl: './control-deck.html',
  styleUrl: './control-deck.css',
})
export class ControlDeck {
  protected readonly replay = inject(ReplayService);
  protected readonly expanded = signal(false);

  protected startRow = 2400;
  protected endRow = 3399;

  protected toggle(): void {
    this.expanded.update((value) => !value);
  }

  protected startReplay(): void {
    this.replay.start(this.startRow, this.endRow);
  }
}
