import type { Edge, LoadlineDocument, Node as DiagramNode, NodeKind, Preset } from '@loadline/model';
import { latencyPercentile, meanLatency, percentilesOf, utilization } from './formulas.js';
import { createRng, type Rng } from './rng.js';

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

/**
 * Состояние узла для интерфейса: idle — трафик не доходит, warm — ρ ≥ 0,7 (задержка растёт),
 * hot — ρ ≥ 0,9, over — ρ ≥ 1 (лишнее уходит в ошибки или в backlog очереди), down — отказ.
 */
export type LoadStatus = 'idle' | 'ok' | 'warm' | 'hot' | 'over' | 'down';

/**
 * Как узел передаёт запрос дальше по исходящим связям:
 * - split — каждый запрос уходит в одну связь, поток делится поровну (клиент, балансировщик, CDN, шлюз, кэш);
 * - fanout — каждый запрос зовёт все связи (сервисы, воркеры, хранилища);
 * - async — очередь: каждый потребитель получает все сообщения, отправитель не ждёт.
 */
export type Routing = 'split' | 'fanout' | 'async';

export interface NodeMetrics {
  id: string;
  /** λ — входящий поток, rps. */
  lambda: number;
  /** Входящие чтения и записи, rps. */
  readRps: number;
  writeRps: number;
  /** ρ — загрузка. Может быть больше 1 при перегрузе. */
  rho: number;
  /** c · μ — ёмкость узла, rps. 0 при отказе. */
  capacityRps: number;
  /** Обслужено, rps. */
  servedRps: number;
  /** Отказано из-за перегруза или отказа узла, rps. За очередью это отставание, а не ошибки. */
  droppedRps: number;
  /** С какой скоростью растёт backlog очереди: сообщения, которые потребители не успевают взять, rps. */
  backlogRps: number;
  /** С какой скоростью потребители могут разбирать накопленный backlog, rps (только для queue). */
  drainRps: number;
  /** Узел получает трафик только из очередей: его перегруз — отставание, а не ошибки клиента. */
  behindQueue: boolean;
  /** W — среднее время ответа узла, мс. */
  meanLatencyMs: number;
  p95Ms: number;
  p99Ms: number;
  costMonthlyUsd: number;
  status: LoadStatus;
}

export interface EdgeMetrics {
  id: string;
  /** Поток по связи, rps. */
  rps: number;
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
  /** Узел с наибольшей загрузкой среди тех, до кого доходит трафик. */
  bottleneckId: string | null;
  /** Сколько сэмплов Монте-Карло посчитано. */
  samples: number;
}

export interface SimulationResult {
  nodes: Record<string, NodeMetrics>;
  edges: Record<string, EdgeMetrics>;
  system: SystemMetrics;
  /** Предупреждения модели: циклы, висящие связи, неизвестные пресеты. */
  warnings: string[];
}

export interface SimulateOptions {
  presets: readonly Preset[];
  /**
   * Число сэмплов Монте-Карло. По умолчанию — из бюджета обхода (см. samplesFor):
   * 20 000, а для схем, где один сэмпл обходит больше 50 узлов, меньше, но не меньше 2 000.
   */
  samples?: number;
  /** Seed генератора. По умолчанию 1. */
  seed?: number;
}

/** Компоненты, которые отвечают из себя с вероятностью hitRatio (только для чтений). */
const CACHING_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['cache', 'cdn']);
/** Компоненты, после которых клиент не ждёт обработки ниже по графу. */
const ASYNC_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['queue']);
/** Компоненты, которые отправляют каждый запрос в одну из связей. */
const SPLIT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'client',
  'load-balancer',
  'cdn',
  'api-gateway',
  'cache',
]);

export function routingOf(kind: NodeKind): Routing {
  if (ASYNC_KINDS.has(kind)) return 'async';
  return SPLIT_KINDS.has(kind) ? 'split' : 'fanout';
}

/** Сколько потока уходит в каждую исходящую связь: при split поток делится, иначе копируется. */
function shareOf(routing: Routing, outCount: number): number {
  return routing === 'split' && outCount > 0 ? 1 / outCount : 1;
}

/** Несёт ли связь запрос этого вида. Без only связь несёт и чтения, и записи. */
export function carries(e: Edge, isRead: boolean): boolean {
  return e.only === undefined || e.only === (isRead ? 'read' : 'write');
}

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
  /** Откуда приходят связи: id узлов-источников. */
  inbound: Map<string, string[]>;
  order: string[];
  entries: string[];
}

function buildGraph(doc: LoadlineDocument, presets: readonly Preset[], warnings: string[]): Graph {
  const nodes = new Map<string, ResolvedNode>();
  for (const n of doc.nodes) nodes.set(n.id, resolveNode(n, presets, warnings));

  const out = new Map<string, Edge[]>();
  const inbound = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    out.set(id, []);
    inbound.set(id, []);
  }
  for (const e of doc.edges) {
    const from = nodeIdOf(e.from);
    const to = nodeIdOf(e.to);
    if (!nodes.has(from) || !nodes.has(to)) {
      warnings.push(`Связь ${e.id} ведёт к несуществующему узлу`);
      continue;
    }
    out.get(from)!.push(e);
    inbound.get(to)!.push(from);
  }

  // Входы: явные клиенты, иначе узлы без входящих связей.
  const clients = [...nodes.values()].filter((n) => n.kind === 'client').map((n) => n.id);
  const entries =
    clients.length > 0 ? clients : [...nodes.keys()].filter((id) => inbound.get(id)!.length === 0);

  // Топологический порядок (Кан). Узлы в циклах в порядок не попадут.
  const deg = new Map([...inbound].map(([id, from]) => [id, from.length]));
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

  return { nodes, out, inbound, order, entries };
}

function statusOf(n: ResolvedNode, lambda: number, rho: number): LoadStatus {
  if (n.outage) return 'down';
  if (lambda < 1e-9 && n.kind !== 'client') return 'idle';
  if (rho >= 1) return 'over';
  if (rho >= STATUS_HOT) return 'hot';
  if (rho >= STATUS_WARM) return 'warm';
  return 'ok';
}

/**
 * Аналитический проход: потоки по графу, загрузка, средние и перцентили каждого узла.
 * Как поток идёт дальше, решает routingOf(kind): split делит его между связями, fanout и async копируют.
 */
function analyze(
  doc: LoadlineDocument,
  g: Graph,
): { nodes: Record<string, NodeMetrics>; edges: Record<string, EdgeMetrics> } {
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

  const nodes: Record<string, NodeMetrics> = {};
  const edges: Record<string, EdgeMetrics> = {};
  for (const id of g.order) {
    const n = g.nodes.get(id)!;
    const r = reads.get(id) ?? 0;
    const w = writes.get(id) ?? 0;
    const lambda = r + w;

    const capacity = n.outage ? 0 : n.replicas * n.capacityRps;
    const rho = n.outage ? (lambda > 0 ? Infinity : 0) : utilization(lambda, n.replicas, n.capacityRps);

    // Лишний поток сверх c·μ уходит в ошибки (за очередью — в отставание, см. backlog ниже).
    const served = Math.min(lambda, capacity);
    const dropped = lambda - served;

    const share = lambda > 0 ? served / lambda : 0;
    let downR = r * share;
    const downW = w * share;
    if (CACHING_KINDS.has(n.kind)) downR *= 1 - n.hitRatio;

    // Чтения и записи идут каждое по своим связям: связь с only несёт только один вид запросов.
    const outs = g.out.get(id) ?? [];
    const routing = routingOf(n.kind);
    const kr = shareOf(routing, outs.filter((e) => carries(e, true)).length);
    const kw = shareOf(routing, outs.filter((e) => carries(e, false)).length);
    for (const e of outs) {
      const to = nodeIdOf(e.to);
      const er = carries(e, true) ? downR * kr : 0;
      const ew = carries(e, false) ? downW * kw : 0;
      reads.set(to, (reads.get(to) ?? 0) + er);
      writes.set(to, (writes.get(to) ?? 0) + ew);
      edges[e.id] = { id: e.id, rps: er + ew };
    }

    const from = g.inbound.get(id)!;
    const W = n.outage ? 0 : meanLatency(n.baseLatencyMs, rho);
    nodes[id] = {
      id,
      lambda,
      readRps: r,
      writeRps: w,
      rho,
      capacityRps: capacity,
      servedRps: served,
      droppedRps: dropped,
      backlogRps: 0,
      drainRps: 0,
      behindQueue: from.length > 0 && from.every((f) => ASYNC_KINDS.has(g.nodes.get(f)!.kind)),
      meanLatencyMs: W,
      p95Ms: latencyPercentile(W, 0.95),
      p99Ms: latencyPercentile(W, 0.99),
      costMonthlyUsd: n.replicas * n.costPerReplicaUsd,
      status: statusOf(n, lambda, rho),
    };
  }

  // Очереди: потребитель, который не успевает, не роняет запросы клиента, а копит backlog.
  // Растёт он на недообслуженную долю потока каждой связи, разбирается запасом ёмкости потребителей.
  for (const id of g.order) {
    const q = nodes[id]!;
    if (!ASYNC_KINDS.has(g.nodes.get(id)!.kind)) continue;
    for (const e of g.out.get(id) ?? []) {
      const c = nodes[nodeIdOf(e.to)];
      if (!c) continue;
      const ok = c.lambda > 0 ? c.servedRps / c.lambda : 1;
      q.backlogRps += (edges[e.id]?.rps ?? 0) * (1 - ok);
      q.drainRps += Math.max(0, c.capacityRps - c.lambda);
    }
  }

  return { nodes, edges };
}

/** Коды маршрутизации в скомпилированном графе (Routing без строк). */
const R_SPLIT = 0;
const R_FANOUT = 1;
const R_ASYNC = 2;
/** Узел вне топологического порядка (в цикле): сэмпл проходит его за 0 мс. */
const R_SKIP = 3;

/** Дети узла i лежат в child[start[i] .. start[i + 1]). */
interface Adjacency {
  start: Int32Array;
  child: Int32Array;
  parallel: Uint8Array;
}

/**
 * Граф для Монте-Карло в виде индексов и типизированных массивов: горячий цикл не трогает
 * строки, Map и объекты метрик. Связи с only попадают только в свой список: чтения идут по reads,
 * записи по writes.
 */
interface Sampler {
  routing: Uint8Array;
  outage: Uint8Array;
  /** Вероятность отказа из-за перегруза; -1, если потока нет и бросать монетку не нужно. */
  dropP: Float64Array;
  /** Среднее время ответа узла W, мс. */
  mean: Float64Array;
  /** hit ratio для кэша и CDN; -1 у остальных узлов. */
  hit: Float64Array;
  reads: Adjacency;
  writes: Adjacency;
}

function buildAdjacency(count: number): { start: Int32Array; child: number[]; parallel: number[] } {
  return { start: new Int32Array(count + 1), child: [], parallel: [] };
}

function compileSampler(g: Graph, metrics: Record<string, NodeMetrics>, index: Map<string, number>): Sampler {
  const count = g.nodes.size;
  const s: Sampler = {
    routing: new Uint8Array(count),
    outage: new Uint8Array(count),
    dropP: new Float64Array(count),
    mean: new Float64Array(count),
    hit: new Float64Array(count),
    reads: { start: new Int32Array(0), child: new Int32Array(0), parallel: new Uint8Array(0) },
    writes: { start: new Int32Array(0), child: new Int32Array(0), parallel: new Uint8Array(0) },
  };
  const r = buildAdjacency(count);
  const w = buildAdjacency(count);
  for (const [id, n] of g.nodes) {
    const i = index.get(id)!;
    r.start[i] = r.child.length;
    w.start[i] = w.child.length;
    const m = metrics[id];
    if (!m) {
      s.routing[i] = R_SKIP;
      continue;
    }
    const routing = routingOf(n.kind);
    s.routing[i] = routing === 'split' ? R_SPLIT : routing === 'async' ? R_ASYNC : R_FANOUT;
    s.outage[i] = n.outage ? 1 : 0;
    s.dropP[i] = m.lambda > 0 ? m.droppedRps / m.lambda : -1;
    s.mean[i] = m.meanLatencyMs;
    s.hit[i] = CACHING_KINDS.has(n.kind) ? n.hitRatio : -1;
    for (const e of g.out.get(id) ?? []) {
      const to = index.get(nodeIdOf(e.to))!;
      const par = e.mode === 'parallel' ? 1 : 0;
      for (const [adj, isRead] of [[r, true], [w, false]] as const) {
        if (!carries(e, isRead)) continue;
        adj.child.push(to);
        adj.parallel.push(par);
      }
    }
  }
  // Map обходит узлы в порядке вставки, а index выдан в том же порядке: start монотонен.
  r.start[count] = r.child.length;
  w.start[count] = w.child.length;
  s.reads = { start: r.start, child: Int32Array.from(r.child), parallel: Uint8Array.from(r.parallel) };
  s.writes = { start: w.start, child: Int32Array.from(w.child), parallel: Uint8Array.from(w.parallel) };
  return s;
}

/** Сэмплов по умолчанию, если схема укладывается в бюджет обхода. */
export const DEFAULT_SAMPLES = 20_000;
/** Меньше не берём: на p99 остаётся 20 сэмплов хвоста. */
export const MIN_SAMPLES = 2_000;
/** Сколько посещений узлов допускает один пересчёт: ≈ 40 мс при ≈ 40 нс на посещение. */
export const VISIT_BUDGET = 1_000_000;

/**
 * Сколько узлов в среднем обходит один сэмпл. Считается тем же проходом, что и поток в analyze,
 * но по правилам sampleRequest: очередь не ждёт потребителей, кэш обрывает попадания.
 * Отказы учитываются только как доля обслуженных, поэтому это оценка сверху.
 */
function visitsPerSample(s: Sampler, order: Int32Array, entries: Int32Array, readShare: number): number {
  const count = s.routing.length;
  const vr = new Float64Array(count);
  const vw = new Float64Array(count);
  for (const e of entries) {
    vr[e]! += readShare / entries.length;
    vw[e]! += (1 - readShare) / entries.length;
  }
  for (const i of order) {
    if (s.outage[i] || s.routing[i] === R_ASYNC) continue;
    const keep = s.dropP[i]! > 0 ? 1 - s.dropP[i]! : 1;
    const r = vr[i]! * keep * (s.hit[i]! >= 0 ? 1 - s.hit[i]! : 1);
    const w = vw[i]! * keep;
    // Чтения и записи расходятся каждое по своим связям, у split доля своя для каждого вида.
    for (const [adj, v, x] of [[s.reads, vr, r], [s.writes, vw, w]] as const) {
      const from = adj.start[i]!;
      const n = adj.start[i + 1]! - from;
      const k = s.routing[i] === R_SPLIT ? 1 / n : 1;
      for (let c = from; c < from + n; c++) v[adj.child[c]!]! += x * k;
    }
  }
  let total = 0;
  for (let i = 0; i < count; i++) total += vr[i]! + vw[i]!;
  return total;
}

/**
 * Число сэмплов по бюджету обхода. Сэмплов меньше там, где сэмпл длинный, и точность от этого
 * не страдает: время такого запроса — сумма (или максимум) многих экспонент, и относительный
 * разброс его перцентилей намного меньше, чем у короткого пути (замеры в docs/how-we-calculate.md).
 */
export function samplesFor(visits: number): number {
  if (!(visits > 0)) return DEFAULT_SAMPLES;
  return Math.max(MIN_SAMPLES, Math.min(DEFAULT_SAMPLES, Math.floor(VISIT_BUDGET / visits)));
}

/** Результат сэмпла «запрос получил ошибку». Время запроса не бывает отрицательным. */
const FAILED = -1;

/**
 * Монте-Карло: прогоняем сэмплы запросов по графу и собираем сквозные перцентили.
 * Возвращает время запроса или FAILED, если запрос получил ошибку.
 *
 * Случайные числа берутся в том же порядке, что и в исходной рекурсии по Graph:
 * монетка отказа (если у узла есть поток), время узла (если W > 0), попадание в кэш (чтение
 * через кэш или CDN), выбор связи при split с несколькими связями. Поэтому сэмплы те же,
 * что у прежней реализации, и перцентили совпадают бит в бит.
 */
function sampleRequest(i: number, isRead: boolean, s: Sampler, rng: Rng, depth: number): number {
  const routing = s.routing[i]!;
  if (routing === R_SKIP || depth > 64) return 0;
  if (s.outage[i]) return FAILED;
  const dropP = s.dropP[i]!;
  if (dropP >= 0 && rng() < dropP) return FAILED;

  // sampleExp, развёрнутый на месте: 1 - u, чтобы не получить ln(0).
  const mean = s.mean[i]!;
  let t = mean <= 0 ? 0 : -mean * Math.log(1 - rng());

  const hit = s.hit[i]!;
  if (hit >= 0 && isRead && rng() < hit) return t;
  if (routing === R_ASYNC) return t;

  const adj = isRead ? s.reads : s.writes;
  const from = adj.start[i]!;
  const count = adj.start[i + 1]! - from;
  if (count === 0) return t;

  // split: запрос уходит ровно в одну связь, выбранную равновероятно.
  // При одной связи выбирать нечего: не тратим случайное число, чтобы не сдвигать поток сэмплов.
  if (routing === R_SPLIT) {
    const k = count === 1 ? 0 : Math.floor(rng() * count);
    const c = sampleRequest(adj.child[from + k]!, isRead, s, rng, depth + 1);
    return c === FAILED ? FAILED : t + c;
  }

  let parallelMax = 0;
  for (let k = from; k < from + count; k++) {
    const c = sampleRequest(adj.child[k]!, isRead, s, rng, depth + 1);
    if (c === FAILED) return FAILED;
    if (adj.parallel[k]) parallelMax = Math.max(parallelMax, c);
    else t += c;
  }
  return t + parallelMax;
}

export function simulate(doc: LoadlineDocument, options: SimulateOptions): SimulationResult {
  const warnings: string[] = [];
  const g = buildGraph(doc, options.presets, warnings);
  const { nodes, edges } = analyze(doc, g);

  const rng = createRng(options.seed ?? 1);
  const readShare = doc.traffic.readShare ?? 1;
  const incoming = doc.traffic.rps * (doc.traffic.spike ?? 1);

  let samples = 0;
  // Float64Array: без упаковки чисел и без роста массива в горячем цикле.
  let buffer = new Float64Array(0);
  let ok = 0;
  let failed = 0;
  if (g.entries.length > 0 && incoming > 0) {
    const index = new Map<string, number>();
    for (const id of g.nodes.keys()) index.set(id, index.size);
    const sampler = compileSampler(g, nodes, index);
    const entries = Int32Array.from(g.entries, (id) => index.get(id)!);
    const order = Int32Array.from(g.order, (id) => index.get(id)!);
    samples = options.samples ?? samplesFor(visitsPerSample(sampler, order, entries, readShare));
    buffer = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
      const entry = entries[Math.floor(rng() * entries.length)]!;
      const t = sampleRequest(entry, rng() < readShare, sampler, rng, 0);
      if (t === FAILED) failed++;
      else buffer[ok++] = t;
    }
  }
  const times = buffer.subarray(0, ok);

  const total = ok + failed;
  const errorRate = total > 0 ? failed / total : 0;
  let sum = 0;
  for (let i = 0; i < ok; i++) sum += times[i]!;
  const mean = ok > 0 ? sum / ok : 0;
  // Полная сортировка не нужна: из выборки берём только три перцентиля.
  const [p50, p95, p99] = percentilesOf(times, [0.5, 0.95, 0.99]) as [number, number, number];

  let bottleneckId: string | null = null;
  let maxRho = -1;
  for (const m of Object.values(nodes)) {
    if (g.nodes.get(m.id)?.kind === 'client' || m.lambda <= 0) continue;
    if (m.rho > maxRho) {
      maxRho = m.rho;
      bottleneckId = m.id;
    }
  }

  return {
    nodes,
    edges,
    warnings,
    system: {
      incomingRps: incoming,
      servedRps: incoming * (1 - errorRate),
      errorRate,
      meanLatencyMs: mean,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      costMonthlyUsd: Object.values(nodes).reduce((s, m) => s + m.costMonthlyUsd, 0),
      bottleneckId,
      samples,
    },
  };
}
