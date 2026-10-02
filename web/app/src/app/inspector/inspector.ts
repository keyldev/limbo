import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { explainNode, resolveNode, routingOf } from '@loadline/engine';
import type { NodeParams } from '@loadline/model';
import { nodeIdOfPort } from '../board/board-contract';
import { Icon } from '../catalog/icon';
import { ROUTING_TEXT, kindInfo } from '../catalog/kinds';
import { EditorStore } from '../editor/editor-store';
import { SimulationService } from '../simulation/simulation.service';
import { errorPct, fmt, fmtMs, money, pct } from '../ui/format';

const HOT_LIST = 7;

/**
 * Правая панель. Выбран узел — его параметры и показания; выбрана связь — поток по ней;
 * ничего не выбрано — загрузка системы по узлам.
 */
@Component({
  selector: 'll-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './inspector.html',
  styleUrl: './inspector.css',
})
export class Inspector {
  protected readonly store = inject(EditorStore);
  private readonly sim = inject(SimulationService);

  protected readonly fmt = fmt;
  protected readonly fmtMs = fmtMs;
  protected readonly money = money;
  protected readonly pct = pct;
  protected readonly errorPct = errorPct;

  protected readonly node = this.store.selectedNode;
  protected readonly edge = this.store.selectedEdge;

  protected readonly metrics = computed(() => {
    const n = this.node();
    return n ? this.store.result()?.nodes[n.id] : undefined;
  });

  /** Параметры узла с подставленным пресетом: то, что реально считает движок. */
  protected readonly resolved = computed(() => {
    const n = this.node();
    return n ? resolveNode(n, this.sim.presets(), []) : null;
  });

  protected readonly kindLabel = computed(() => {
    const n = this.node();
    return n ? kindInfo(n.kind).label : '';
  });

  protected readonly routingText = computed(() => {
    const n = this.node();
    if (!n) return '';
    return n.kind === 'client' ? ROUTING_TEXT.source : ROUTING_TEXT[routingOf(n.kind)];
  });

  protected readonly hasHitRatio = computed(() => {
    const k = this.node()?.kind;
    return k === 'cache' || k === 'cdn';
  });

  protected readonly explanation = computed(() => {
    const r = this.resolved();
    const m = this.metrics();
    return r && m ? explainNode(r, m) : [];
  });

  protected readonly edgeInfo = computed(() => {
    const e = this.edge();
    const doc = this.store.doc();
    const result = this.store.result();
    if (!e || !doc) return null;
    const from = doc.nodes.find((n) => n.id === nodeIdOfPort(e.from));
    const toId = nodeIdOfPort(e.to);
    const routing = from ? (from.kind === 'client' ? 'source' : routingOf(from.kind)) : 'fanout';
    return {
      fromName: this.store.nameOf(nodeIdOfPort(e.from)),
      toName: this.store.nameOf(toId),
      routingText: ROUTING_TEXT[routing],
      canBeParallel: routing === 'fanout',
      mode: e.mode ?? 'sequential',
      rps: result?.edges[e.id]?.rps ?? 0,
      target: result?.nodes[toId],
    };
  });

  protected readonly hotList = computed(() => {
    const doc = this.store.doc();
    const result = this.store.result();
    if (!doc || !result) return [];
    return doc.nodes
      .filter((n) => n.kind !== 'client')
      .map((n) => ({ node: n, m: result.nodes[n.id] }))
      .filter((x) => x.m && (x.m.lambda > 0 || x.node.params?.outage))
      .sort((a, b) => b.m!.rho - a.m!.rho)
      .slice(0, HOT_LIST);
  });

  protected readonly system = computed(() => this.store.result()?.system ?? null);

  protected setParam<K extends keyof NodeParams>(key: K, value: NodeParams[K]): void {
    const n = this.node();
    if (n) this.store.updateNode(n.id, { params: { [key]: value } });
  }

  /** Числовое поле: пустое или вне диапазона — не применяем, пусть пользователь допечатает. */
  protected setNumber(
    key: 'capacityRps' | 'baseLatencyMs' | 'costPerReplicaUsd',
    raw: string,
    min: number,
    max: number,
  ): void {
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v) || v < min || v > max) return;
    this.setParam(key, v);
  }

  protected stepReplicas(delta: number): void {
    const r = this.resolved();
    if (r) this.setParam('replicas', Math.min(64, Math.max(1, r.replicas + delta)));
  }

  protected rename(value: string): void {
    const n = this.node();
    const label = value.trim();
    if (n && label) this.store.updateNode(n.id, { label });
  }

  protected tone(rate: number, warn: number, bad: number): string {
    return rate >= bad ? 'over' : rate >= warn ? 'hot' : 'ok';
  }
}
