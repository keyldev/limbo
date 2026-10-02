import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import type { SimulationResult } from '@loadline/engine';

@Component({
  selector: 'll-metrics-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, PercentPipe],
  template: `
    @if (result(); as r) {
      <dl>
        <div><dt>Обслужено</dt><dd>{{ r.system.servedRps | number: '1.0-0' }} rps</dd></div>
        <div [class.bad]="r.system.errorRate > 0.01">
          <dt>Ошибки</dt><dd>{{ r.system.errorRate | percent: '1.0-1' }}</dd>
        </div>
        <div><dt>Средняя задержка</dt><dd>{{ r.system.meanLatencyMs | number: '1.0-1' }} мс</dd></div>
        <div><dt>p95</dt><dd>{{ r.system.p95Ms | number: '1.0-1' }} мс</dd></div>
        <div><dt>p99</dt><dd>{{ r.system.p99Ms | number: '1.0-1' }} мс</dd></div>
        <div><dt>Стоимость</dt><dd>\${{ r.system.costMonthlyUsd | number: '1.0-0' }} / мес</dd></div>
        <div><dt>Узкое место</dt><dd class="mono">{{ r.system.bottleneckId ?? '—' }}</dd></div>
      </dl>
      @for (w of r.warnings; track w) {
        <p class="warning">{{ w }}</p>
      }
    } @else {
      <p class="muted">Считаем…</p>
    }
  `,
  styles: `
    dl { margin: 0; display: grid; gap: 2px; }
    dl > div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--ll-border); }
    dt { color: var(--ll-text-muted); }
    dd { margin: 0; font-family: var(--ll-mono); font-variant-numeric: tabular-nums; }
    .bad dd { color: var(--ll-hot); }
    .mono { font-family: var(--ll-mono); }
    .warning { color: var(--ll-warm); font-size: 12px; margin: 8px 0 0; }
    .muted { color: var(--ll-text-muted); }
  `,
})
export class MetricsPanel {
  readonly result = input<SimulationResult | null>(null);
}
