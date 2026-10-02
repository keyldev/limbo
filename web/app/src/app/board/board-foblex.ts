import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { SimulationResult } from '@loadline/engine';
import type { LoadlineDocument } from '@loadline/model';
import {
  FCanvasComponent,
  FFlowComponent,
  FFlowModule,
  type FCreateConnectionEvent,
  type FMoveNodesEvent,
  type FReassignConnectionEvent,
  type FSelectionChangeEvent,
} from '@foblex/flow';
import {
  inPort,
  outPort,
  type BoardConnect,
  type BoardMove,
  type BoardReconnect,
  type BoardSelection,
} from './board-contract';
import { NodeCard } from './node-card';

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Прототип доски на Foblex Flow (ADR 0003).
 * Id коннекторов совпадают с портами документа (`узел:in`, `узел:out`),
 * поэтому события библиотеки переводятся в события доски почти без преобразований.
 */
@Component({
  selector: 'll-board-foblex',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FFlowModule, NodeCard],
  template: `
    <f-flow
      fDraggable
      (fNodesRendered)="onRendered()"
      (fMoveNodes)="onMove($event)"
      (fCreateConnection)="onCreate($event)"
      (fReassignConnection)="onReassign($event)"
      (fSelectionChange)="onSelection($event)"
    >
      <f-background><f-circle-pattern [radius]="1" /></f-background>
      <f-canvas fZoom [fZoomMinimum]="0.2" [fZoomMaximum]="3">
        <f-connection-for-create fType="bezier" />
        @for (e of doc()?.edges ?? []; track e.id) {
          <f-connection
            [fConnectionId]="e.id"
            [fSourceId]="e.from"
            [fTargetId]="e.to"
            fType="bezier"
            fBehavior="fixed"
            [class.parallel]="e.mode === 'parallel'"
          >
            <f-connection-marker-arrow type="end" />
          </f-connection>
        }
        @for (n of doc()?.nodes ?? []; track n.id) {
          <div fNode [fNodeId]="n.id" [fNodePosition]="n.pos" fDragHandle class="ll-node-host">
            <div
              fConnector
              fConnectorType="target"
              fConnectorConnectableSide="left"
              [fConnectorId]="inPort(n.id)"
              class="ll-port in"
            ></div>
            <ll-node-card [node]="n" [metrics]="result()?.nodes?.[n.id]" />
            <div
              fConnector
              fConnectorType="source"
              fConnectorConnectableSide="right"
              [fConnectorId]="outPort(n.id)"
              class="ll-port out"
            ></div>
          </div>
        }
      </f-canvas>
    </f-flow>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
})
export class BoardFoblex {
  readonly doc = input<LoadlineDocument | null>(null);
  readonly result = input<SimulationResult | null>(null);
  /** Меняется, когда загружена другая схема: доску нужно вписать в экран заново. */
  readonly fitKey = input<unknown>(null);
  /** Выделение в приложении — источник правды; доска подстраивает под него своё. */
  readonly selection = input<BoardSelection>({ nodeId: null, edgeId: null });

  readonly selectionChange = output<BoardSelection>();
  readonly move = output<BoardMove[]>();
  readonly connect = output<BoardConnect>();
  readonly reconnect = output<BoardReconnect>();

  protected readonly inPort = inPort;
  protected readonly outPort = outPort;

  private readonly canvas = viewChild(FCanvasComponent);
  private readonly flow = viewChild(FFlowComponent);
  private pendingFit = true;

  constructor() {
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
        if (!sameIds(cur.fNodeIds, nodes) || !sameIds(cur.fConnectionIds, edges))
          flow.select(nodes, edges, false);
      });
    });
  }

  protected onRendered(): void {
    if (!this.pendingFit) return;
    this.pendingFit = false;
    this.canvas()?.fitToScreen({ x: 60, y: 60 }, false);
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
}
