import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { NodeMetrics } from '@loadline/engine';
import type { Node as DiagramNode } from '@loadline/model';
import { Icon } from '../catalog/icon';
import { kindInfo } from '../catalog/kinds';
import { fmt, pct } from '../ui/format';

const SEGMENTS = 12;

/**
 * Карточка узла на доске: иконка, имя, тип и реплики, плашка состояния,
 * сегментированная шкала загрузки и строка с потоком.
 * Порты сюда не входят: их рисует доска директивами Foblex.
 */
@Component({
  selector: 'll-node-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { '[attr.data-status]': 'status()' },
  template: `
    <div class="head">
      <span class="ico"><ll-icon [kind]="node().kind" /></span>
      <span class="text">
        <b>{{ node().label ?? node().id }}</b>
        <i>{{ kindLabel() }}{{ replicas() > 1 ? ' ×' + replicas() : '' }}</i>
      </span>
      <span class="pill">{{ status() }}</span>
    </div>
    @if (node().kind === 'client') {
      <div class="stats client">
        <span>{{ fmt(metrics()?.lambda ?? 0) }} rps наружу</span>
        <span>{{ links() > 0 ? linksText() : 'не подключён' }}</span>
      </div>
    } @else {
      <div class="bar" aria-hidden="true">
        @for (on of segments(); track $index) {
          <i [class.on]="on"></i>
        }
      </div>
      <div class="stats">
        <span>{{ fmt(metrics()?.lambda ?? 0) }} rps</span>
        <span>{{ right() }}</span>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 7px;
      width: 100%;
      height: 100%;
      padding: 9px 12px 8px;
      background: var(--ll-surface);
      border: 1px solid var(--ll-border);
      border-radius: 9px;
      box-shadow: var(--ll-shadow);
      color: var(--ll-text);
      font-family: var(--ll-font);
      transition:
        border-color 0.2s,
        background-color 0.2s;
    }
    :host([data-status='idle']) {
      opacity: 0.75;
    }
    :host([data-status='warm']) {
      border-color: color-mix(in srgb, var(--ll-warm) 45%, var(--ll-border));
    }
    :host([data-status='hot']) {
      border-color: color-mix(in srgb, var(--ll-hot) 60%, var(--ll-border));
    }
    :host([data-status='over']) {
      border-color: var(--ll-hot);
      background: linear-gradient(var(--ll-hot-soft), var(--ll-surface) 65%);
      animation: ll-alarm 0.6s ease-out 1;
    }
    :host([data-status='down']) {
      border-color: var(--ll-hot);
      background-image: repeating-linear-gradient(
        135deg,
        transparent 0 7px,
        var(--ll-border) 7px 8px
      );
    }
    /* Единственное мигание в интерфейсе: короткий сигнал при перегрузе. */
    @keyframes ll-alarm {
      0% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--ll-hot) 60%, transparent);
      }
      100% {
        box-shadow: 0 0 0 10px transparent;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none !important;
        transition: none;
      }
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .ico {
      display: grid;
      place-items: center;
      flex: none;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--ll-surface-2);
      border: 1px solid var(--ll-border);
      color: var(--ll-text);
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    .text b {
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .text i {
      font-style: normal;
      font-size: 11px;
      color: var(--ll-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pill {
      flex: none;
      padding: 2px 5px;
      border-radius: 4px;
      font: 600 9.5px var(--ll-mono);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--ll-surface-2);
      color: var(--ll-text-muted);
    }
    :host([data-status='ok']) .pill {
      background: var(--ll-ok-soft);
      color: var(--ll-ok);
    }
    :host([data-status='warm']) .pill {
      background: var(--ll-warm-soft);
      color: var(--ll-warm);
    }
    :host([data-status='hot']) .pill {
      background: var(--ll-hot-soft);
      color: var(--ll-hot);
    }
    :host([data-status='over']) .pill,
    :host([data-status='down']) .pill {
      background: var(--ll-hot);
      color: var(--ll-surface);
    }
    .bar {
      display: grid;
      grid-template-columns: repeat(${SEGMENTS}, 1fr);
      gap: 2px;
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
    :host([data-status='hot']) .bar i.on,
    :host([data-status='over']) .bar i.on {
      background: var(--ll-hot);
    }
    .stats {
      display: flex;
      justify-content: space-between;
      font: 500 11px var(--ll-mono);
      color: var(--ll-text-muted);
    }
    .stats.client {
      margin-top: auto;
    }
  `,
})
export class NodeCard {
  readonly node = input.required<DiagramNode>();
  readonly metrics = input<NodeMetrics | undefined>(undefined);
  /** Накопленный backlog, если узел — очередь. */
  readonly backlog = input(0);
  /** Сколько у узла исходящих связей (для клиента). */
  readonly links = input(0);

  protected readonly fmt = fmt;
  protected readonly kindLabel = computed(() => kindInfo(this.node().kind).label);
  protected readonly replicas = computed(() => this.node().params?.replicas ?? 1);
  protected readonly status = computed(() => this.metrics()?.status ?? 'idle');

  protected readonly segments = computed(() => {
    const m = this.metrics();
    const rho = !m ? 0 : Number.isFinite(m.rho) ? m.rho : 1;
    const lit = Math.min(SEGMENTS, Math.ceil(Math.min(rho, 1) * SEGMENTS - 1e-9));
    return Array.from({ length: SEGMENTS }, (_, i) => i < lit);
  });

  protected readonly right = computed(() => {
    const m = this.metrics();
    if (this.node().params?.outage) return 'offline';
    if (this.node().kind === 'queue' && this.backlog() >= 1)
      return `backlog ${fmt(this.backlog())}`;
    return m ? pct(m.rho) : '—';
  });

  protected readonly linksText = computed(() => {
    const n = this.links();
    const word =
      n % 10 === 1 && n % 100 !== 11
        ? 'связь'
        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
          ? 'связи'
          : 'связей';
    return `${n} ${word}`;
  });
}
