import type { Edge, LoadlineDocument, Node as DiagramNode, NodeKind, Preset } from '@loadline/model';
import { latencyPercentile, meanLatency, percentileOfSorted, utilization } from './formulas.js';
import { createRng, sampleExp, type Rng } from './rng.js';

/** Параметры узла после подстановки пресета. */
export interface ResolvedNode {
  id: string;
  kind: NodeKind;
  replicas: number;
  capacityRps: number;
  baseLatencyMs: number;
  hitRatio: number;
  costPerReplicaUsd: number;
  outage: boolean;
}

export type LoadStatus = 'ok' | 'warm' | 'hot' | 'down';

export interface NodeMetrics {
  id: string;
  /** λ — входящий поток, rps. */
  lambda: number;
  /** Входящие чтения и записи, rps. */
  readRps: number;
  writeRps: number;
  /** ρ — загрузка. Может быть больше 1 при перегрузе. */
  rho: number;
  /** Обслужено, rps. */
  servedRps: number;
  /** Отказано из-за перегруза или отказа узла, rps. */
  droppedRps: number;
  /** Накопление за очередью, rps (только для queue). */
  backlogRps: number;
  /** W — среднее время ответа узла, мс. */
  meanLatencyMs: number;
  p95Ms: number;
  p99Ms: number;
  costMonthlyUsd: number;
  status: LoadStatus;
}

export interface SystemMetrics {
  incomingRps: number;
  servedRps: number;
  /** Доля неуспешных запросов, 0..1. */
  errorRate: number;
  meanLatencyMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  costMonthlyUsd: number;
  /** Узел с наибольшей загрузкой. */
  bottleneckId: string | null;
}

export interface SimulationResult {
  nodes: Record<string, NodeMetrics>;
  system: SystemMetrics;
  /** Предупреждения модели: циклы, висящие связи, неизвестные пресеты. */
  warnings: string[];
}

export interface SimulateOptions {
  presets: readonly Preset[];
  /** Число сэмплов Монте-Карло. По умолчанию 20 000. */
  samples?: number;
  /** Seed генератора. По умолчанию 1. */
  seed?: number;
}

/** Компоненты, которые отвечают из себя с вероятностью hitRatio (только для чтений). */
const CACHING_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['cache', 'cdn']);
/** Компоненты, после которых клиент не ждёт обработки ниже по графу. */
const ASYNC_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['queue']);

const STATUS_WARM = 0.7;
const STATUS_HOT = 0.9;

function nodeIdOf(port: string): string {
  const i = port.lastIndexOf(':');
  return i === -1 ? port : port.slice(0, i);
}

export function resolveNode(node: DiagramNode, presets: readonly Preset[], warnings: string[]): ResolvedNode {
  const preset =
    (node.preset ? presets.find((p) => p.id === node.preset) : undefined) ??
    presets.find((p) => p.kind === node.kind);
  if (!preset) warnings.push(`Узел ${node.id}: нет пресета для типа ${node.kind}`);
  if (node.preset && preset && preset.id !== node.preset) {
    warnings.push(`Узел ${node.id}: пресет ${node.preset} не найден, взят ${preset.id}`);
  }
  const p = node.params ?? {};
  return {
    id: node.id,
    kind: node.kind,
    replicas: p.replicas ?? 1,
    capacityRps: p.capacityRps ?? preset?.capacityRps ?? 1,
    baseLatencyMs: p.baseLatencyMs ?? preset?.baseLatencyMs ?? 0,
    hitRatio: p.hitRatio ?? preset?.hitRatio ?? 0,
    costPerReplicaUsd: p.costPerReplicaUsd ?? preset?.costPerReplicaUsd ?? 0,
    outage: p.outage ?? false,
  };
}

interface Graph {
  nodes: Map<string, ResolvedNode>;
  out: Map<string, Edge[]>;
  inDegree: Map<string, number>;
  order: string[];
  entries: string[];
}

function buildGraph(doc: LoadlineDocument, presets: readonly Preset[], warnings: string[]): Graph {
  const nodes = new Map<string, ResolvedNode>();
  for (const n of doc.nodes) nodes.set(n.id, resolveNode(n, presets, warnings));

  const out = new Map<string, Edge[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodes.keys()) {
    out.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of doc.edges) {
    const from = nodeIdOf(e.from);
    const to = nodeIdOf(e.to);
    if (!nodes.has(from) || !nodes.has(to)) {
      warnings.push(`Связь ${e.id} ведёт к несуществующему узлу`);
      continue;
    }
    out.get(from)!.push(e);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  // Входы: явные клиенты, иначе узлы без входящих связей.
  const clients = [...nodes.values()].filter((n) => n.kind === 'client').map((n) => n.id);
  const entries = clients.length > 0 ? clients : [...nodes.keys()].filter((id) => inDegree.get(id) === 0);

  // Топологический порядок (Кан). Узлы в циклах в порядок не попадут.
  const deg = new Map(inDegree);
  const queue = [...nodes.keys()].filter((id) => deg.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of out.get(id)!) {
      const to = nodeIdOf(e.to);
      const d = (deg.get(to) ?? 0) - 1;
      deg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  if (order.length < nodes.size) {
    warnings.push('В схеме есть цикл: узлы в цикле не считаются');
  }

  return { nodes, out, inDegree, order, entries };
}

function statusOf(rho: number, outage: boolean): LoadStatus {
  if (outage) return 'down';
  if (rho >= STATUS_HOT) return 'hot';
  if (rho >= STATUS_WARM) return 'warm';
  return 'ok';
}

/**
 * Аналитический проход: потоки по графу, загрузка, средние и перцентили каждого узла.
 * Сервис зовёт каждую исходящую зависимость с полным обслуженным потоком.
 */
function analyze(doc: LoadlineDocument, g: Graph): Record<string, NodeMetrics> {
  const spike = doc.traffic.spike ?? 1;
  const readShare = doc.traffic.readShare ?? 1;
  const incoming = doc.traffic.rps * spike;

  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  for (const id of g.nodes.keys()) {
    reads.set(id, 0);
    writes.set(id, 0);
  }
  const perEntry = g.entries.length > 0 ? incoming / g.entries.length : 0;
  for (const id of g.entries) {
    reads.set(id, perEntry * readShare);
    writes.set(id, perEntry * (1 - readShare));
  }

  const result: Record<string, NodeMetrics> = {};
  for (const id of g.order) {
    const n = g.nodes.get(id)!;
    const r = reads.get(id) ?? 0;
    const w = writes.get(id) ?? 0;
    const lambda = r + w;

    const capacity = n.outage ? 0 : n.replicas * n.capacityRps;
    const rho = n.outage ? (lambda > 0 ? Infinity : 0) : utilization(lambda, n.replicas, n.capacityRps);
    const isQueue = ASYNC_KINDS.has(n.kind);

    // Лишний поток сверх c·μ уходит в ошибки. Очередь тоже: она отказывает,
    // когда не успевает записывать, а вот медленные потребители копят backlog.
    const served = Math.min(lambda, capacity);
    const dropped = lambda - served;
    let backlog = 0;

    const share = lambda > 0 ? served / lambda : 0;
    let downR = r * share;
    const downW = w * share;
    if (CACHING_KINDS.has(n.kind)) downR *= 1 - n.hitRatio;

    // За очередью: если потребители не успевают, разница копится в backlog.
    if (isQueue) {
      const consumers = (g.out.get(id) ?? []).map((e) => g.nodes.get(nodeIdOf(e.to))!);
      const consumerCap = consumers.reduce(
        (s, c) => s + (c.outage ? 0 : c.replicas * c.capacityRps),
        0,
      );
      const outFlow = downR + downW;
      if (consumers.length > 0 && outFlow > consumerCap) {
        backlog = outFlow - consumerCap;
      }
    }

    for (const e of g.out.get(id) ?? []) {
      const to = nodeIdOf(e.to);
      let rr = downR;
      let ww = downW;
      if (isQueue && backlog > 0) {
        const k = (downR + downW - backlog) / (downR + downW);
        rr *= k;
        ww *= k;
      }
      reads.set(to, (reads.get(to) ?? 0) + rr);
      writes.set(to, (writes.get(to) ?? 0) + ww);
    }

    const W = n.outage ? 0 : meanLatency(n.baseLatencyMs, rho);
    result[id] = {
      id,
      lambda,
      readRps: r,
      writeRps: w,
      rho,
      servedRps: served,
      droppedRps: dropped,
      backlogRps: backlog,
      meanLatencyMs: W,
      p95Ms: latencyPercentile(W, 0.95),
      p99Ms: latencyPercentile(W, 0.99),
      costMonthlyUsd: n.replicas * n.costPerReplicaUsd,
      status: statusOf(rho, n.outage),
    };
  }
  return result;
}

/**
 * Монте-Карло: прогоняем сэмплы запросов по графу и собираем сквозные перцентили.
 * Возвращает время запроса или null, если запрос получил ошибку.
 */
function sampleRequest(
  id: string,
  isRead: boolean,
  g: Graph,
  metrics: Record<string, NodeMetrics>,
  rng: Rng,
  depth: number,
): number | null {
  const n = g.nodes.get(id);
  const m = metrics[id];
  if (!n || !m || depth > 64) return 0;
  if (n.outage) return null;
  if (m.lambda > 0 && rng() < m.droppedRps / m.lambda) return null;

  let t = sampleExp(rng, m.meanLatencyMs);

  if (CACHING_KINDS.has(n.kind) && isRead && rng() < n.hitRatio) return t;
  if (ASYNC_KINDS.has(n.kind)) return t;

  const edges = g.out.get(id) ?? [];
  let parallelMax = 0;
  for (const e of edges) {
    const child = sampleRequest(nodeIdOf(e.to), isRead, g, metrics, rng, depth + 1);
    if (child === null) return null;
    if (e.mode === 'parallel') parallelMax = Math.max(parallelMax, child);
    else t += child;
  }
  return t + parallelMax;
}

export function simulate(doc: LoadlineDocument, options: SimulateOptions): SimulationResult {
  const warnings: string[] = [];
  const g = buildGraph(doc, options.presets, warnings);
  const nodes = analyze(doc, g);

  const samples = options.samples ?? 20_000;
  const rng = createRng(options.seed ?? 1);
  const readShare = doc.traffic.readShare ?? 1;
  const incoming = doc.traffic.rps * (doc.traffic.spike ?? 1);

  const times: number[] = [];
  let failed = 0;
  if (g.entries.length > 0 && incoming > 0) {
    for (let i = 0; i < samples; i++) {
      const entry = g.entries[Math.floor(rng() * g.entries.length)]!;
      const t = sampleRequest(entry, rng() < readShare, g, nodes, rng, 0);
      if (t === null) failed++;
      else times.push(t);
    }
  }
  times.sort((a, b) => a - b);

  const total = times.length + failed;
  const errorRate = total > 0 ? failed / total : 0;
  const mean = times.length > 0 ? times.reduce((s, x) => s + x, 0) / times.length : 0;

  let bottleneckId: string | null = null;
  let maxRho = -1;
  for (const m of Object.values(nodes)) {
    if (g.nodes.get(m.id)?.kind === 'client') continue;
    if (m.rho > maxRho) {
      maxRho = m.rho;
      bottleneckId = m.id;
    }
  }

  return {
    nodes,
    warnings,
    system: {
      incomingRps: incoming,
      servedRps: incoming * (1 - errorRate),
      errorRate,
      meanLatencyMs: mean,
      p50Ms: percentileOfSorted(times, 0.5),
      p95Ms: percentileOfSorted(times, 0.95),
      p99Ms: percentileOfSorted(times, 0.99),
      costMonthlyUsd: Object.values(nodes).reduce((s, m) => s + m.costMonthlyUsd, 0),
      bottleneckId,
    },
  };
}
