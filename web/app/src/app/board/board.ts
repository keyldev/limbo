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
import type { SimulationResult } from '@loadline/engine';
import type { LoadlineDocument, NodeKind, Position } from '@loadline/model';
import {
  FCanvasComponent,
  FFlowComponent,
  FFlowModule,
  FZoomDirective,
  type FCanvasChangeEvent,
  type FCreateConnectionEvent,
  type FMoveNodesEvent,
  type FReassignConnectionEvent,
  type FSelectionChangeEvent,
} from '@foblex/flow';
import { fmt } from '../ui/format';
import {
  NODE_H,
  NODE_W,
  PALETTE_MIME,
  inPort,
  nodeIdOfPort,
  outPort,
  type BoardConnect,
  type BoardMove,
  type BoardReconnect,
  type BoardSelection,
} from './board-contract';
import { FlowDots } from './flow-dots';
import { NodeCard } from './node-card';

const GRID = 12;
/** Ниже этого масштаба подписи потока на связях только мешают. */
const LABEL_MIN_SCALE = 0.55;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Доска на Foblex Flow (ADR 0003).
 * Id коннекторов совпадают с портами документа (`узел:in`, `узел:out`),
 * поэтому события библиотеки переводятся в события доски почти без преобразований.
 */
@Component({
  selector: 'll-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FFlowModule, NodeCard, FlowDots],
  template: `
    <div
      class="viewport"
      [class.paused]="!playing()"
      (dragover)="onDragOver($event)"
      (drop)="onDrop($event)"
    >
      <f-flow
        fDraggable
        [vCellSize]="grid"
        [hCellSize]="grid"
        (fNodesRendered)="onRendered()"
        (fMoveNodes)="onMove($event)"
        (fCreateConnection)="onCreate($event)"
        (fReassignConnection)="onReassign($event)"
        (fSelectionChange)="onSelection($event)"
      >
        <f-background><f-circle-pattern [radius]="24" /></f-background>
        <f-canvas fZoom [fZoomMinimum]="0.3" [fZoomMaximum]="2" (fCanvasChange)="onCanvas($event)">
          <f-connection-for-create fType="bezier" />
          @for (e of edges(); track e.id) {
            <f-connection
              [fConnectionId]="e.id"
              [fSourceId]="e.from"
              [fTargetId]="e.to"
              fType="bezier"
              fBehavior="fixed"
              [llFlowDots]="e.rps"
              class="ll-wire"
              [attr.data-status]="e.status"
              [class.dry]="e.rps <= 0"
              [class.parallel]="e.parallel"
              [style.--ll-w.px]="e.width"
            >
              <f-connection-marker-arrow type="end" />
              @if (showLabels() && e.rps > 0) {
                <div fConnectionContent [position]="0.5" [offset]="-11" class="ll-elabel">
                  {{ fmt(e.rps) }} rps{{ e.only ? ' · ' + e.only : '' }}
                </div>
              }
            </f-connection>
          }
          @for (n of doc()?.nodes ?? []; track n.id) {
            <div fNode [fNodeId]="n.id" [fNodePosition]="n.pos" fDragHandle class="ll-node-host">
              @if (n.kind !== 'client') {
                <div
                  fConnector
                  fConnectorType="target"
                  fConnectorConnectableSide="left"
                  [fConnectorId]="inPort(n.id)"
                  class="ll-port in"
                ></div>
              }
              <ll-node-card
                [node]="n"
                [metrics]="result()?.nodes?.[n.id]"
                [backlog]="backlog()[n.id] ?? 0"
                [links]="outCount().get(n.id) ?? 0"
              />
              <div
                fConnector
                fConnectorType="source"
                fConnectorConnectableSide="right"
                [fConnectorId]="outPort(n.id)"
                class="ll-port out"
                title="Потяните к другому узлу, чтобы связать"
              ></div>
            </div>
          }
        </f-canvas>
      </f-flow>

      @if ((doc()?.nodes?.length ?? 0) === 0) {
        <div class="empty">
          Перетащите компонент из списка слева, затем потяните его правый порт к следующему.
        </div>
      }

      <div class="zoom" role="group" aria-label="Масштаб">
        <button type="button" (click)="zoomIn()" aria-label="Приблизить">+</button>
        <button type="button" (click)="zoomOut()" aria-label="Отдалить">−</button>
        <button type="button" (click)="fit(true)" aria-label="Вписать схему в экран">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
          </svg>
        </button>
        <span class="pct">{{ zoomPct() }}%</span>
      </div>
      <div class="hint">
        Тяните от <i class="portdot"></i> к узлу, чтобы связать · пустое место — панорама · колесо —
        масштаб · Delete удаляет
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
    .viewport {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      text-align: center;
      color: var(--ll-text-muted);
      pointer-events: none;
    }
    .zoom {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px;
      background: var(--ll-surface);
      border: 1px solid var(--ll-border);
      border-radius: 8px;
      box-shadow: var(--ll-shadow);
    }
    .zoom button {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: none;
      cursor: pointer;
      font-size: 16px;
    }
    .zoom button:hover {
      border-color: var(--ll-border);
    }
    .pct {
      min-width: 40px;
      text-align: center;
      font: 500 11px var(--ll-mono);
      color: var(--ll-text-muted);
    }
    .hint {
      position: absolute;
      left: 12px;
      bottom: 10px;
      z-index: 2;
      max-width: calc(100% - 24px);
      padding: 4px 8px;
      border-radius: 6px;
      pointer-events: none;
      background: color-mix(in srgb, var(--ll-surface) 88%, transparent);
      font: 400 11px var(--ll-mono);
      color: var(--ll-text-muted);
    }
    .portdot {
      display: inline-block;
      width: 8px;
      height: 8px;
      vertical-align: 0;
      transform: rotate(45deg);
      border: 1.5px solid var(--ll-wire);
    }
    @media (max-width: 640px) {
      .hint {
        display: none;
      }
    }
  `,
})
export class Board {
  readonly doc = input<LoadlineDocument | null>(null);
  readonly result = input<SimulationResult | null>(null);
  /** Меняется, когда загружена другая схема: доску нужно вписать в экран заново. */
  readonly fitKey = input<unknown>(null);
  /** Выделение в приложении — источник правды; доска подстраивает под него своё. */
  readonly selection = input<BoardSelection>({ nodeId: null, edgeId: null });
  readonly backlog = input<Readonly<Record<string, number>>>({});
  /** Идёт ли симуляция: на паузе точки на связях стоят. */
  readonly playing = input(true);
  /** Запрос палитры добавить компонент в центр видимой части. */
  readonly addRequest = input<{ kind: NodeKind; seq: number } | null>(null);

  readonly selectionChange = output<BoardSelection>();
  readonly move = output<BoardMove[]>();
  readonly connect = output<BoardConnect>();
  readonly reconnect = output<BoardReconnect>();
  readonly add = output<{ kind: NodeKind; pos: Position }>();

  protected readonly fmt = fmt;
  protected readonly grid = GRID;
  protected readonly inPort = inPort;
  protected readonly outPort = outPort;

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly canvas = viewChild(FCanvasComponent);
  private readonly flow = viewChild(FFlowComponent);
  private readonly zoom = viewChild(FZoomDirective);
  private readonly scale = signal(1);
  private pendingFit = true;

  protected readonly zoomPct = computed(() => Math.round(this.scale() * 100));
  protected readonly showLabels = computed(() => this.scale() >= LABEL_MIN_SCALE);

  protected readonly outCount = computed(() => {
    const counts = new Map<string, number>();
    for (const e of this.doc()?.edges ?? []) {
      const id = nodeIdOfPort(e.from);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  });

  /** Связи с потоком и состоянием узла, в который они ведут. */
  protected readonly edges = computed(() => {
    const result = this.result();
    return (this.doc()?.edges ?? []).map((e) => {
      const rps = result?.edges[e.id]?.rps ?? 0;
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        parallel: e.mode === 'parallel',
        only: e.only === 'read' ? 'чтения' : e.only === 'write' ? 'записи' : '',
        rps,
        status: result?.nodes[nodeIdOfPort(e.to)]?.status ?? 'idle',
        width: rps > 0 ? Math.min(4, Math.max(1.4, 1.2 + Math.log10(rps + 1) * 0.7)) : 1.2,
      };
    });
  });

  constructor() {
    // Первый прогон — это значение на момент создания доски, а не новый клик: его пропускаем.
    let first = true;
    effect(() => {
      const r = this.addRequest();
      if (first) {
        first = false;
        return;
      }
      if (r) untracked(() => this.addAtCenter(r.kind));
    });

    effect(() => {
      this.fitKey();
      this.pendingFit = true;
    });

    // Узел мог исчезнуть и вернуться (удаление и отмена), а Foblex помнит старое выделение
    // и не шлёт событие при повторном клике. Поэтому после каждой отрисовки сверяемся.
    effect(() => {
      const s = this.selection();
      this.doc();
      const flow = this.flow();
      if (!flow) return;
      setTimeout(() => {
        const nodes = s.nodeId ? [s.nodeId] : [];
        const edges = s.edgeId ? [s.edgeId] : [];
        const cur = flow.getSelection();
        if (!sameIds(cur.fNodeIds, nodes) || !sameIds(cur.fConnectionIds, edges)) {
          flow.select(nodes, edges, false);
        }
      });
    });
  }

  zoomIn(): void {
    this.zoom()?.zoomIn();
  }

  zoomOut(): void {
    this.zoom()?.zoomOut();
  }

  fit(animated = false): void {
    // Мелкую схему не раздуваем больше 110%: крупные карточки на пустом экране читаются хуже.
    this.canvas()?.fitToScreen({ x: 48, y: 48 }, animated, true, 1.1);
  }

  /** Добавить компонент в центр видимой части доски (клик по палитре). */
  private addAtCenter(kind: NodeKind): void {
    const r = this.host.getBoundingClientRect();
    const count = this.doc()?.nodes.length ?? 0;
    const jitter = (count % 5) * 24;
    const p = this.toFlow(r.left + r.width / 2, r.top + r.height / 2);
    this.add.emit({
      kind,
      pos: this.snap({ x: p.x - NODE_W / 2 + jitter, y: p.y - NODE_H / 2 + jitter }),
    });
  }

  protected onRendered(): void {
    if (!this.pendingFit) return;
    this.pendingFit = false;
    this.fit();
  }

  protected onCanvas(e: FCanvasChangeEvent): void {
    this.scale.set(e.scale);
  }

  protected onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes(PALETTE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  protected onDrop(e: DragEvent): void {
    const kind = e.dataTransfer?.getData(PALETTE_MIME) as NodeKind | undefined;
    if (!kind) return;
    e.preventDefault();
    const p = this.toFlow(e.clientX, e.clientY);
    this.add.emit({ kind, pos: this.snap({ x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }) });
  }

  protected onMove(e: FMoveNodesEvent): void {
    this.move.emit(
      e.nodes.map((n) => ({
        id: n.id,
        pos: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      })),
    );
  }

  protected onCreate(e: FCreateConnectionEvent): void {
    if (e.targetId) this.connect.emit({ from: e.sourceId, to: e.targetId });
  }

  protected onReassign(e: FReassignConnectionEvent): void {
    this.reconnect.emit({
      edgeId: e.connectionId,
      from: e.nextSourceId ?? e.previousSourceId,
      to: e.nextTargetId ?? e.previousTargetId,
    });
  }

  protected onSelection(e: FSelectionChangeEvent): void {
    this.selectionChange.emit({ nodeId: e.nodeIds[0] ?? null, edgeId: e.connectionIds[0] ?? null });
  }

  private toFlow(clientX: number, clientY: number): Position {
    const p = this.flow()?.getPositionInFlow({ x: clientX, y: clientY });
    return { x: p?.x ?? 0, y: p?.y ?? 0 };
  }

  private snap(p: Position): Position {
    return { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
  }
}
