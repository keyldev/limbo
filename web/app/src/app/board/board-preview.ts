import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { NodeMetrics, SimulationResult } from '@loadline/engine';
import type { LoadlineDocument } from '@loadline/model';

const NODE_W = 132;
const NODE_H = 52;

interface BoardEdge {
  id: string;
  d: string;
  parallel: boolean;
}

/**
 * Временный предпросмотр доски на чистом SVG: только показывает схему и загрузку.
 * Перетаскивание, связи порт-в-порт и зум даст библиотека доски
 * (Foblex Flow или ngx-vflow, выбор на неделе 2, ADR 0003).
 */
@Component({
  selector: 'll-board-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="viewBox()" role="img" aria-label="Схема системы">
      <defs>
        <marker id="ll-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" class="arrow" />
        </marker>
      </defs>
      @for (e of edges(); track e.id) {
        <path [attr.d]="e.d" class="edge" [class.parallel]="e.parallel" marker-end="url(#ll-arrow)" />
      }
      @for (n of doc()?.nodes ?? []; track n.id) {
        @let m = metricsOf(n.id);
        <g
          class="node"
          [class.selected]="n.id === selectedId()"
          [attr.data-status]="m?.status ?? 'ok'"
          [attr.transform]="'translate(' + n.pos.x + ',' + n.pos.y + ')'"
          (click)="select.emit(n.id)"
          tabindex="0"
          (keydown.enter)="select.emit(n.id)"
        >
          <rect [attr.width]="nodeW" [attr.height]="nodeH" rx="8" />
          <rect class="load" [attr.width]="loadWidth(m)" height="4" [attr.y]="nodeH - 4" rx="2" />
          <text class="name" [attr.x]="12" y="22">{{ n.label ?? n.id }}</text>
          <text class="kind" [attr.x]="12" y="39">{{ n.kind }} · ρ {{ formatRho(m) }}</text>
        </g>
      }
    </svg>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; }
    svg { width: 100%; height: 100%; }
    .edge { fill: none; stroke: var(--ll-border); stroke-width: 1.5; }
    .edge.parallel { stroke-dasharray: 5 4; }
    .arrow { fill: var(--ll-border); }
    .node { cursor: pointer; outline: none; }
    .node rect:first-child { fill: var(--ll-surface); stroke: var(--ll-border); stroke-width: 1.25; }
    .node.selected rect:first-child, .node:focus-visible rect:first-child { stroke: var(--ll-accent); stroke-width: 2; }
    .node .load { fill: var(--ll-ok); }
    .node[data-status='warm'] .load { fill: var(--ll-warm); }
    .node[data-status='hot'] .load { fill: var(--ll-hot); }
    .node[data-status='hot'] rect:first-child { stroke: var(--ll-hot); }
    .node[data-status='down'] { opacity: 0.55; }
    .node[data-status='down'] .load { fill: var(--ll-down); }
    .name { fill: var(--ll-text); font-size: 13px; font-weight: 600; }
    .kind { fill: var(--ll-text-muted); font-size: 11px; font-family: var(--ll-mono); }
  `,
})
export class BoardPreview {
  readonly doc = input<LoadlineDocument | null>(null);
  readonly result = input<SimulationResult | null>(null);
  readonly selectedId = input<string | null>(null);
  readonly select = output<string>();

  protected readonly nodeW = NODE_W;
  protected readonly nodeH = NODE_H;

  protected readonly viewBox = computed(() => {
    const nodes = this.doc()?.nodes ?? [];
    if (nodes.length === 0) return '0 0 800 400';
    const xs = nodes.map((n) => n.pos.x);
    const ys = nodes.map((n) => n.pos.y);
    const minX = Math.min(...xs) - 24;
    const minY = Math.min(...ys) - 24;
    const w = Math.max(...xs) + NODE_W + 24 - minX;
    const h = Math.max(...ys) + NODE_H + 24 - minY;
    return `${minX} ${minY} ${w} ${h}`;
  });

  protected readonly edges = computed<BoardEdge[]>(() => {
    const doc = this.doc();
    if (!doc) return [];
    const pos = new Map(doc.nodes.map((n) => [n.id, n.pos]));
    return doc.edges.flatMap((e) => {
      const a = pos.get(e.from.split(':')[0] ?? '');
      const b = pos.get(e.to.split(':')[0] ?? '');
      if (!a || !b) return [];
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      return [{ id: e.id, d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2 - 2} ${y2}`, parallel: e.mode === 'parallel' }];
    });
  });

  protected metricsOf(id: string): NodeMetrics | undefined {
    return this.result()?.nodes[id];
  }

  protected loadWidth(m: NodeMetrics | undefined): number {
    if (!m || !Number.isFinite(m.rho)) return m ? NODE_W : 0;
    return Math.min(m.rho, 1) * NODE_W;
  }

  protected formatRho(m: NodeMetrics | undefined): string {
    if (!m) return '—';
    if (!Number.isFinite(m.rho)) return '∞';
    return m.rho.toFixed(2);
  }
}
