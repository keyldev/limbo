import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT_LIMITS, type LoadStatus, type SimulationResult } from '@loadline/engine';
import type { LoadlineDocument, NodeKind, Position } from '@loadline/model';
import type {
  BoardConnect,
  BoardMove,
  BoardReconnect,
  BoardSelection,
} from '../board/board-contract';
import { nodeIdOfPort } from '../board/board-contract';
import { kindInfo } from '../catalog/kinds';
import { SimulationService } from '../simulation/simulation.service';
import { fmt, pct } from '../ui/format';
import {
  addEdge,
  addNode,
  connectProblem,
  moveNodes,
  reconnectEdge,
  removeEdge,
  removeNode,
  setEdgeMode,
  setEdgeOnly,
  updateNode,
  type NodePatch,
} from './edits';
import { History } from './history';

export type LogLevel = 'info' | 'warn' | 'hot' | 'over' | 'ok';

export interface LogEntry {
  id: number;
  /** Время симуляции, с. */
  t: number;
  level: LogLevel;
  text: string;
}

const LOG_LIMIT = 80;
const TICK_MS = 100;
const SPIKE_FACTOR = 4;
const SPIKE_SECONDS = 8;

const NO_SELECTION: BoardSelection = { nodeId: null, edgeId: null };

/**
 * Состояние редактора: документ (через SimulationService), выделение, история, лог событий,
 * часы симуляции, временный всплеск трафика и накопленный backlog очередей.
 * Компоненты только читают сигналы и зовут методы.
 */
@Injectable({ providedIn: 'root' })
export class EditorStore {
  private readonly sim = inject(SimulationService);

  readonly doc = this.sim.doc.asReadonly();
  readonly result = this.sim.result.asReadonly();
  readonly history = new History<LoadlineDocument>();

  readonly selection = signal<BoardSelection>(NO_SELECTION);
  readonly log = signal<readonly LogEntry[]>([]);
  readonly clock = signal(0);
  readonly playing = signal(true);
  private readonly spikeUntil = signal(-1);
  /** Накопленный backlog по id очереди, сообщений. */
  readonly backlog = signal<Readonly<Record<string, number>>>({});
  /** Растёт при каждой загрузке схемы: доска по нему вписывает схему в экран. */
  readonly loadCount = signal(0);
  /** Клик по палитре: доска ставит компонент в центр того, что сейчас видно. */
  readonly addRequest = signal<{ kind: NodeKind; seq: number } | null>(null);

  readonly spiking = computed(() => this.clock() < this.spikeUntil());
  readonly spikeLeft = computed(() => Math.max(0, Math.ceil(this.spikeUntil() - this.clock())));
  readonly selectedNode = computed(
    () => this.doc()?.nodes.find((n) => n.id === this.selection().nodeId) ?? null,
  );
  readonly selectedEdge = computed(
    () => this.doc()?.edges.find((e) => e.id === this.selection().edgeId) ?? null,
  );

  private logSeq = 0;
  /** Состояния узлов на прошлом результате: для сообщений о переходах. null — схема только загружена. */
  private prevStatus: Map<string, LoadStatus> | null = null;

  constructor() {
    effect(() => this.sim.spike.set(this.spiking() ? SPIKE_FACTOR : 1));

    effect(() => {
      const result = this.result();
      if (result) untracked(() => this.reportTransitions(result));
    });

    let timer: ReturnType<typeof setInterval> | null = null;
    effect(() => {
      if (timer) clearInterval(timer);
      timer = null;
      if (!this.playing()) return;
      let last = performance.now();
      timer = setInterval(() => {
        const now = performance.now();
        const dt = Math.min(0.5, (now - last) / 1000);
        last = now;
        this.tick(dt);
      }, TICK_MS);
    });
    inject(DestroyRef).onDestroy(() => timer && clearInterval(timer));
  }

  // ---------- загрузка и симуляция ----------

  /**
   * Открыть другую схему. Прежняя уходит в историю, поэтому случайно выбранный сценарий
   * не съедает работу: Ctrl+Z возвращает её. При первом запуске (fresh) истории нет.
   */
  load(doc: LoadlineDocument, opts: { fresh?: boolean; note?: string } = {}): void {
    const prev = this.doc();
    if (opts.fresh || !prev) this.history.clear();
    else this.history.record(prev);
    this.selection.set(NO_SELECTION);
    this.backlog.set({});
    this.spikeUntil.set(-1);
    this.prevStatus = null;
    this.sim.doc.set(doc);
    this.log.set([]);
    const title = doc.meta?.title ?? 'без названия';
    const undo = !opts.fresh && prev ? ' · Ctrl+Z вернёт прежнюю' : '';
    this.push('info', `${opts.note ?? 'Загружена схема'} «${title}»${undo}`);
    this.loadCount.update((n) => n + 1);
  }

  setTitle(title: string): void {
    const t = title.trim().slice(0, DOCUMENT_LIMITS.title);
    this.apply(
      (d) => (t === (d.meta?.title ?? '') ? d : { ...d, meta: { ...d.meta, title: t } }),
      'title',
    );
  }

  togglePlay(): void {
    this.playing.update((p) => !p);
  }

  /** Трафик — это ручка симуляции, а не правка схемы: в историю не пишем. */
  setRps(rps: number): void {
    const d = this.doc();
    if (d && d.traffic.rps !== rps) this.sim.doc.set({ ...d, traffic: { ...d.traffic, rps } });
  }

  spike(): void {
    const rps = this.doc()?.traffic.rps ?? 0;
    this.spikeUntil.set(this.clock() + SPIKE_SECONDS);
    this.playing.set(true);
    this.push('warn', `Всплеск трафика: ${fmt(rps * SPIKE_FACTOR)} rps на ${SPIKE_SECONDS} секунд`);
  }

  private tick(dt: number): void {
    this.clock.update((c) => c + dt);
    const result = this.result();
    if (!result) return;
    this.backlog.update((prev) => {
      const next: Record<string, number> = {};
      for (const m of Object.values(result.nodes)) {
        if (this.doc()?.nodes.find((n) => n.id === m.id)?.kind !== 'queue') continue;
        const cur = prev[m.id] ?? 0;
        next[m.id] = Math.max(0, cur + (m.backlogRps - (cur > 0 ? m.drainRps : 0)) * dt);
      }
      return next;
    });
  }

  // ---------- выделение ----------

  select(s: BoardSelection): void {
    const cur = this.selection();
    if (cur.nodeId !== s.nodeId || cur.edgeId !== s.edgeId) this.selection.set(s);
  }

  selectNode(id: string): void {
    this.select({ nodeId: id, edgeId: null });
  }

  clearSelection(): void {
    this.select(NO_SELECTION);
  }

  // ---------- правки ----------

  requestAdd(kind: NodeKind): void {
    this.addRequest.update((r) => ({ kind, seq: (r?.seq ?? 0) + 1 }));
  }

  addNode(kind: NodeKind, pos: Position): void {
    const d = this.doc();
    if (!d) return;
    const { doc, node } = addNode(d, kind, pos);
    this.commit(doc);
    this.selectNode(node.id);
    this.push('info', `Добавлен ${kindInfo(kind).label.toLowerCase()} «${node.label}»`);
  }

  move(moves: BoardMove[]): void {
    this.apply((d) => moveNodes(d, moves));
  }

  connect(c: BoardConnect): void {
    const d = this.doc();
    if (!d) return;
    const problem = connectProblem(d, c);
    if (problem) {
      // Порт в порт, которого нет, — это просто промах мышью, а не повод для сообщения.
      if (!problem.startsWith('такого')) {
        this.push(
          'warn',
          `${this.nameOfPort(c.from)} → ${this.nameOfPort(c.to)}: связь не создана, ${problem}`,
        );
      }
      return;
    }
    this.commit(addEdge(d, c));
    this.push('info', `Связь ${this.nameOfPort(c.from)} → ${this.nameOfPort(c.to)}`);
  }

  reconnect(r: BoardReconnect): void {
    const d = this.doc();
    if (!d) return;
    const problem = connectProblem(d, r, r.edgeId);
    if (problem) {
      this.push('warn', `Связь не перенесена: ${problem}`);
      return;
    }
    this.apply(() => reconnectEdge(d, r));
  }

  updateNode(id: string, patch: NodePatch): void {
    // Ввод имени и щелчки степпера склеиваются в один шаг отмены.
    const key = `${id}:${Object.keys(patch.params ?? {}).join(',')}:${patch.label !== undefined}`;
    this.apply((d) => updateNode(d, id, patch), key);
  }

  setEdgeMode(edgeId: string, mode: 'sequential' | 'parallel'): void {
    this.apply((d) => setEdgeMode(d, edgeId, mode));
  }

  setEdgeOnly(edgeId: string, only: 'read' | 'write' | undefined): void {
    this.apply((d) => setEdgeOnly(d, edgeId, only));
  }

  removeSelected(): void {
    const { nodeId, edgeId } = this.selection();
    const d = this.doc();
    if (!d) return;
    if (edgeId) {
      const e = d.edges.find((x) => x.id === edgeId);
      this.apply((doc) => removeEdge(doc, edgeId));
      if (e)
        this.push('info', `Удалена связь ${this.nameOfPort(e.from)} → ${this.nameOfPort(e.to)}`);
    } else if (nodeId) {
      const name = this.nameOf(nodeId);
      this.apply((doc) => removeNode(doc, nodeId));
      this.push('info', `Удалён узел «${name}»`);
    }
    this.clearSelection();
  }

  undo(): void {
    const d = this.doc();
    const prev = d && this.history.undo(d);
    if (prev) this.sim.doc.set(prev);
  }

  redo(): void {
    const d = this.doc();
    const next = d && this.history.redo(d);
    if (next) this.sim.doc.set(next);
  }

  /** Применяет правку. Если документ не изменился (та же ссылка), в историю ничего не пишется. */
  private apply(fn: (d: LoadlineDocument) => LoadlineDocument, key?: string): void {
    const d = this.doc();
    if (!d) return;
    const next = fn(d);
    if (next !== d) this.commit(next, key);
  }

  private commit(next: LoadlineDocument, key?: string): void {
    const d = this.doc();
    if (d) this.history.record(d, key);
    this.sim.doc.set(next);
  }

  // ---------- лог ----------

  push(level: LogLevel, text: string): void {
    const entry: LogEntry = { id: ++this.logSeq, t: this.clock(), level, text };
    this.log.update((l) => [entry, ...l].slice(0, LOG_LIMIT));
  }

  nameOf(nodeId: string): string {
    const n = this.doc()?.nodes.find((x) => x.id === nodeId);
    return n?.label ?? nodeId;
  }

  private nameOfPort(port: string): string {
    return this.nameOf(nodeIdOfPort(port));
  }

  /** Пишет в лог, какие узлы перегрелись, упали или пришли в норму с прошлого пересчёта. */
  private reportTransitions(result: SimulationResult): void {
    const doc = this.doc();
    // Результат мог прийти для прошлой схемы, пока считалась новая: такой пропускаем.
    if (!doc || doc.nodes.some((n) => !result.nodes[n.id])) return;
    const prev = this.prevStatus;
    const next = new Map<string, LoadStatus>();
    for (const n of doc.nodes) {
      const m = result.nodes[n.id];
      if (!m || n.kind === 'client') continue;
      next.set(n.id, m.status);
      const was = prev?.get(n.id) ?? 'ok';
      const now = m.status;
      if (was === now) continue;
      const name = n.label ?? n.id;
      if (now === 'hot' && was !== 'over') this.push('hot', `${name}: загрузка ${pct(m.rho)}`);
      else if (now === 'over') {
        this.push(
          'over',
          m.behindQueue
            ? `${name} не успевает (${pct(m.rho)}): за очередью копится backlog`
            : `${name} перегружен (${pct(m.rho)}), теряет ${fmt(m.droppedRps)} rps`,
        );
      } else if (now === 'down') this.push('over', `${name} отключён`);
      else if (
        (now === 'ok' || now === 'warm') &&
        (was === 'hot' || was === 'over' || was === 'down')
      ) {
        this.push('ok', `${name} снова в норме (${pct(m.rho)})`);
      }
    }
    this.prevStatus = next;
  }
}
