import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { NodeMetrics } from '@loadline/engine';
import type { Node as DiagramNode } from '@loadline/model';

const SEGMENTS = 10;

/**
 * Карточка узла: имя, тип, загрузка сегментированной шкалой.
 * Одна и та же в обоих прототипах доски, чтобы сравнивать библиотеки, а не вёрстку.
 * Порты сюда не входят: их рисует библиотека доски своими директивами.
 */
@Component({
  selector: 'll-node-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-status]': 'status()' },
  template: `
    <div class="name">{{ node().label ?? node().id }}</div>
    <div class="kind">{{ node().kind }} · ρ {{ rho() }}</div>
    <div class="bar" aria-hidden="true">
      @for (on of segments(); track $index) {
        <i [class.on]="on"></i>
      }
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: 2px;
      width: 100%;
      height: 100%;
      padding: 8px 12px 7px;
      background: var(--ll-surface);
      border: 1.25px solid var(--ll-border);
      border-radius: var(--ll-radius);
      font-family: var(--ll-font);
      color: var(--ll-text);
    }
    :host([data-status='hot']) {
      border-color: var(--ll-hot);
    }
    :host([data-status='down']) {
      opacity: 0.55;
    }
    .name {
      font-size: 13px;
      font-weight: 600;
      line-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .kind {
      font-size: 11px;
      line-height: 14px;
      font-family: var(--ll-mono);
      color: var(--ll-text-muted);
      white-space: nowrap;
    }
    .bar {
      display: grid;
      grid-template-columns: repeat(${SEGMENTS}, 1fr);
      gap: 2px;
      align-self: end;
    }
    .bar i {
      height: 4px;
      border-radius: 1px;
      background: var(--ll-surface-2);
    }
    .bar i.on {
      background: var(--ll-ok);
    }
    :host([data-status='warm']) .bar i.on {
      background: var(--ll-warm);
    }
    :host([data-status='hot']) .bar i.on {
      background: var(--ll-hot);
    }
    :host([data-status='down']) .bar i.on {
      background: var(--ll-down);
    }
  `,
})
export class NodeCard {
  readonly node = input.required<DiagramNode>();
  readonly metrics = input<NodeMetrics | undefined>(undefined);

  protected readonly status = computed(() => this.metrics()?.status ?? 'ok');

  protected readonly rho = computed(() => {
    const m = this.metrics();
    if (!m) return '—';
    return Number.isFinite(m.rho) ? m.rho.toFixed(2) : '∞';
  });

  protected readonly segments = computed(() => {
    const m = this.metrics();
    const rho = !m ? 0 : Number.isFinite(m.rho) ? m.rho : 1;
    const lit = Math.round(Math.min(rho, 1) * SEGMENTS);
    return Array.from({ length: SEGMENTS }, (_, i) => i < lit);
  });
}
