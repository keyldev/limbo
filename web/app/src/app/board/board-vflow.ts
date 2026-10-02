import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { NodeMetrics, SimulationResult } from '@loadline/engine';
import type { Edge as DiagramEdge, LoadlineDocument, Node as DiagramNode } from '@loadline/model';
import {
  Vflow,
  VflowComponent,
  type Connection,
  type ConnectionSettings,
  type Edge,
  type HtmlTemplateNode,
  type NodeSelectedChange,
  type EdgeSelectChange,
  type ReconnectEvent,
} from 'ngx-vflow';
import {
  inPort,
  nodeIdOfPort,
  outPort,
  type BoardConnect,
  type BoardMove,
  type BoardReconnect,
  type BoardSelection,
} from './board-contract';
import { NodeCard } from './node-card';

interface NodeData {
  node: DiagramNode;
  metrics: NodeMetrics | undefined;
}

type FlowNode = HtmlTemplateNode<NodeData>;

/**
 * Прототип доски на ngx-vflow (ADR 0003).
 * Библиотека пишет позицию при перетаскивании прямо в сигнал point узла и сравнивает узлы
 * по ссылке, поэтому объекты узлов кэшируются по id и обновляются через свои сигналы.
 */
@Component({
  selector: 'll-board-vflow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Vflow, NodeCard],
  template: `
    <vflow
      view="auto"
      [nodes]="nodes()"
      [edges]="edges()"
      [minZoom]="0.2"
      [maxZoom]="3"
      [background]="{ type: 'dots', gap: 20, size: 1, backgroundColor: 'var(--ll-bg)' }"
      [connection]="connection"
      (nodeDragEnd)="onDragEnd()"
      (connect)="onConnect($event)"
      (reconnect)="onReconnect($event)"
      (nodesChanges.select)="onNodeSelect($event)"
      (edgesChanges.select)="onEdgeSelect($event)"
    >
      <ng-template let-ctx nodeHtml>
        <div class="ll-node-host" selectable [class.selected]="ctx.selected()">
          <ll-node-card [node]="ctx.data().node" [metrics]="ctx.data().metrics" />
          <handle type="target" position="left" id="in" [template]="port" />
          <handle type="source" position="right" id="out" [template]="port" />
        </div>
      </ng-template>
    </vflow>

    <ng-template #port let-ctx>
      <svg:polygon class="ll-port-svg" [attr.points]="diamond(ctx.point())" />
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
})
export class BoardVflow {
  readonly doc = input<LoadlineDocument | null>(null);
  readonly result = input<SimulationResult | null>(null);
  readonly fitKey = input<unknown>(null);
  /** Выделение в приложении — источник правды; доска подстраивает под него своё. */
  readonly selection = input<BoardSelection>({ nodeId: null, edgeId: null });

  readonly selectionChange = output<BoardSelection>();
  readonly move = output<BoardMove[]>();
  readonly connect = output<BoardConnect>();
  readonly reconnect = output<BoardReconnect>();

  protected readonly connection: ConnectionSettings = {
    mode: 'loose',
    curve: 'bezier',
    marker: { type: 'arrow-closed' },
    validator: (c) => c.sourceHandle === 'out' && c.targetHandle === 'in' && c.source !== c.target,
  };

  private readonly flow = viewChild(VflowComponent);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly nodeCache = new Map<string, FlowNode>();
  private readonly edgeCache = new Map<string, { src: DiagramEdge; flow: Edge }>();
  private readonly selectedNodes = new Set<string>();
  private readonly selectedEdges = new Set<string>();

  /** Набор узлов меняется только при добавлении и удалении: тогда отдаём новый массив. */
  private readonly nodeIds = signal<readonly string[]>([]);
  protected readonly nodes = computed(() => this.nodeIds().map((id) => this.nodeCache.get(id)!));
  protected readonly edges = signal<Edge[]>([]);

  constructor() {
    effect(() => {
      const doc = this.doc();
      const result = this.result();
      untracked(() => this.syncNodes(doc?.nodes ?? [], result));
    });

    effect(() => {
      const doc = this.doc();
      untracked(() => this.syncEdges(doc?.edges ?? []));
    });

    effect(() => {
      const s = this.selection();
      this.nodes();
      this.edges();
      untracked(() => this.syncSelection(s));
    });

    effect(() => {
      this.fitKey();
      untracked(() => this.fitWhenReady());
    });
  }

  /**
   * vflow считает масштаб по текущему размеру холста. Внутри @defer холст первые кадры
   * нулевой высоты, и масштаб упирается в minZoom, поэтому ждём, пока у холста появится размер.
   */
  private fitWhenReady(attempt = 0): void {
    const flow = this.flow();
    const ready = flow?.initialized() && this.host.clientWidth > 0 && this.host.clientHeight > 0;
    if (ready) {
      flow!.fitView({ padding: 0.15 });
      return;
    }
    if (attempt < 40) setTimeout(() => this.fitWhenReady(attempt + 1), 50);
  }

  protected diamond(p: { x: number; y: number }): string {
    const r = 6;
    return `${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}`;
  }

  protected onDragEnd(): void {
    const doc = this.doc();
    if (!doc) return;
    // Узел может тащиться вместе с другими выделенными, поэтому сверяем все позиции.
    const moves: BoardMove[] = [];
    for (const n of doc.nodes) {
      const p = this.nodeCache.get(n.id)?.point();
      if (p && (Math.round(p.x) !== n.pos.x || Math.round(p.y) !== n.pos.y)) {
        moves.push({ id: n.id, pos: { x: Math.round(p.x), y: Math.round(p.y) } });
      }
    }
    if (moves.length > 0) this.move.emit(moves);
  }

  protected onConnect(c: Connection): void {
    this.connect.emit({ from: outPort(c.source), to: inPort(c.target) });
  }

  protected onReconnect({ connection, oldEdge }: ReconnectEvent): void {
    this.reconnect.emit({
      edgeId: oldEdge.id,
      from: outPort(connection.source),
      to: inPort(connection.target),
    });
  }

  protected onNodeSelect(changes: NodeSelectedChange[]): void {
    for (const c of changes) {
      if (c.selected) this.selectedNodes.add(c.id);
      else this.selectedNodes.delete(c.id);
    }
    this.emitSelection();
  }

  protected onEdgeSelect(changes: EdgeSelectChange[]): void {
    for (const c of changes) {
      if (c.selected) this.selectedEdges.add(c.id);
      else this.selectedEdges.delete(c.id);
    }
    this.emitSelection();
  }

  private emitSelection(): void {
    this.selectionChange.emit({
      nodeId: this.selectedNodes.values().next().value ?? null,
      edgeId: this.selectedEdges.values().next().value ?? null,
    });
  }

  private syncSelection(s: BoardSelection): void {
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    if (s.nodeId) this.selectedNodes.add(s.nodeId);
    if (s.edgeId) this.selectedEdges.add(s.edgeId);
    for (const [id, n] of this.nodeCache) {
      const want = id === s.nodeId;
      if (n.selected!() !== want) n.selected!.set(want);
    }
    for (const [id, e] of this.edgeCache) {
      const want = id === s.edgeId;
      if (e.flow.selected!() !== want) e.flow.selected!.set(want);
    }
  }

  private syncNodes(src: readonly DiagramNode[], result: SimulationResult | null): void {
    const seen = new Set<string>();
    for (const n of src) {
      seen.add(n.id);
      const data: NodeData = { node: n, metrics: result?.nodes[n.id] };
      const cached = this.nodeCache.get(n.id);
      if (!cached) {
        this.nodeCache.set(n.id, {
          id: n.id,
          type: 'html-template',
          point: signal({ ...n.pos }),
          selected: signal(false),
          data: signal(data),
        });
        continue;
      }
      const p = cached.point();
      if (p.x !== n.pos.x || p.y !== n.pos.y) cached.point.set({ ...n.pos });
      const old = cached.data!();
      if (old.node !== n || old.metrics !== data.metrics) cached.data!.set(data);
    }
    for (const id of [...this.nodeCache.keys()]) {
      if (!seen.has(id)) {
        this.nodeCache.delete(id);
        this.selectedNodes.delete(id);
      }
    }
    const ids = src.map((n) => n.id);
    const prev = this.nodeIds();
    if (ids.length !== prev.length || ids.some((id, i) => id !== prev[i])) this.nodeIds.set(ids);
  }

  private syncEdges(src: readonly DiagramEdge[]): void {
    let changed = src.length !== this.edgeCache.size;
    const next = new Map<string, { src: DiagramEdge; flow: Edge }>();
    for (const e of src) {
      const cached = this.edgeCache.get(e.id);
      if (cached && cached.src === e) {
        next.set(e.id, cached);
        continue;
      }
      changed = true;
      next.set(e.id, {
        src: e,
        flow: {
          id: e.id,
          source: nodeIdOfPort(e.from),
          target: nodeIdOfPort(e.to),
          sourceHandle: 'out',
          targetHandle: 'in',
          curve: signal('bezier'),
          markers: signal({ end: { type: 'arrow-closed' } }),
          reconnectable: signal(true),
          selected: signal(false),
          data: signal({ parallel: e.mode === 'parallel' }),
        },
      });
    }
    for (const id of this.edgeCache.keys()) if (!next.has(id)) this.selectedEdges.delete(id);
    this.edgeCache.clear();
    for (const [id, v] of next) this.edgeCache.set(id, v);
    if (changed) this.edges.set([...next.values()].map((v) => v.flow));
  }
}
