import type { Edge, LoadlineDocument, Node, NodeKind } from '@loadline/model';
import { DEFAULT_PRESET, classify, type Classified, type Role } from './classify.js';
import { ComposeError, parseCompose, type ComposeService } from './compose.js';
import { layeredLayout } from './layout.js';
import { parseCaddyfile, parseNginx, type ProxyConfig } from './proxy.js';

export type SourceType = 'compose' | 'caddy' | 'nginx';

export interface ImportSource {
  /** Имя файла: по нему узнаём тип и находим, какой контейнер монтирует конфиг прокси. */
  name: string;
  text: string;
}

/** Что стало с контейнером — показывается до импорта, чтобы угадывание было видно. */
export interface ImportedService {
  name: string;
  /** Тип узла. null — узла нет, см. skipped. */
  kind: NodeKind | null;
  skipped?: 'job' | 'proxy' | 'infra' | 'scaled-to-zero';
  why: string;
  replicas: number;
}

export interface ImportResult {
  doc: LoadlineDocument;
  services: ImportedService[];
  /** Догадки о связях, которые стоит проверить глазами. */
  notes: string[];
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Конфиги больше этого — не конфиги. */
export const MAX_SOURCE_BYTES = 256 * 1024;

/** Тип конфига по имени файла, а если имя ничего не говорит — по содержимому. */
export function detectSource(name: string, text: string): SourceType | null {
  const n = name.toLowerCase();
  if (/caddyfile[^/\\]*$/.test(n)) return 'caddy';
  if (/compose[^/\\]*\.ya?ml$/.test(n)) return 'compose';
  if (/nginx[^/\\]*$|\.conf$/.test(n)) return 'nginx';
  if (/^services\s*:/m.test(text)) return 'compose';
  if (/^\s*reverse_proxy\s/m.test(text)) return 'caddy';
  if (/\b(proxy_pass|upstream\s+[\w.-]+\s*\{)/.test(text)) return 'nginx';
  return null;
}

const ENTRY_KINDS: ReadonlySet<NodeKind> = new Set(['cdn', 'load-balancer', 'api-gateway']);
const STORE_KINDS: ReadonlySet<NodeKind> = new Set(['sql-primary', 'nosql']);

/**
 * Порядок по пути запроса: вход → вычисления → данные. Связь против этого порядка
 * (база зовёт API, сервис зовёт балансировщик) — почти всегда ложная догадка.
 */
const RANK: Record<NodeKind, number> = {
  client: 0,
  cdn: 1,
  'load-balancer': 2,
  'api-gateway': 3,
  service: 4,
  worker: 4,
  cache: 5,
  queue: 5,
  'sql-primary': 6,
  'sql-replica': 6,
  nosql: 6,
  'object-storage': 6,
  search: 6,
};

/** Типы, которые сами никого не зовут: исходящие связи из них в compose — не запросы. */
const LEAF_KINDS: ReadonlySet<NodeKind> = new Set([
  'cache',
  'queue',
  'sql-primary',
  'sql-replica',
  'nosql',
  'object-storage',
  'search',
]);

interface Unit {
  name: string;
  role: Role;
  why: string;
  replicas: number;
  published: boolean;
}

const CLIENT = '\u0000clients';

/** Ориентированный граф по именам контейнеров, связи без повторов и в порядке появления. */
class Graph {
  private readonly keys = new Set<string>();
  readonly edges: [string, string][] = [];

  add(a: string, b: string): void {
    const k = `${a}\u0000${b}`;
    if (a === b || this.keys.has(k)) return;
    this.keys.add(k);
    this.edges.push([a, b]);
  }

  remove(pred: (a: string, b: string) => boolean): [string, string][] {
    const removed = this.edges.filter(([a, b]) => pred(a, b));
    for (const [a, b] of removed) this.keys.delete(`${a}\u0000${b}`);
    const kept = this.edges.filter(([a, b]) => !pred(a, b));
    this.edges.splice(0, this.edges.length, ...kept);
    return removed;
  }

  has(a: string, b: string): boolean {
    return this.keys.has(`${a}\u0000${b}`);
  }

  out(a: string): string[] {
    return this.edges.filter(([x]) => x === a).map(([, b]) => b);
  }

  in(b: string): string[] {
    return this.edges.filter(([, y]) => y === b).map(([a]) => a);
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Упоминание хоста в строке: postgres в Host=postgres;… или redis://redis:6379, но не в my-postgres. */
function mentions(text: string, host: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(host)}(?![A-Za-z0-9_-]|\\.[A-Za-z])`).test(text);
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop()!.toLowerCase();
}

/**
 * Собирает схему из docker-compose и конфигов прокси. Типы узлов угадываются по образам
 * и именам, связи — по depends_on, links, адресам в переменных окружения, меткам traefik
 * и апстримам Caddyfile или nginx.conf. Ёмкости — пресеты по умолчанию: это уровень 1
 * плана, без метрик.
 */
export function importConfigs(
  sources: readonly ImportSource[],
  opts: { title?: string } = {},
): ImportResult {
  const typed = sources
    .filter((s) => s.text.trim())
    .map((s) => {
      if (s.text.length > MAX_SOURCE_BYTES)
        throw new ImportError(`${s.name} больше 256 КБ — это не похоже на конфиг`);
      return { ...s, type: detectSource(s.name, s.text) };
    });
  const unknown = typed.find((s) => !s.type);
  if (unknown)
    throw new ImportError(`${unknown.name}: не похоже ни на docker-compose, ни на Caddyfile, ни на nginx.conf`);
  const composeTexts = typed.filter((s) => s.type === 'compose').map((s) => s.text);
  const proxies = typed
    .filter((s) => s.type !== 'compose')
    .map((s) => ({
      source: s.name,
      config: s.type === 'caddy' ? parseCaddyfile(s.text) : parseNginx(s.text),
    }));
  if (!composeTexts.length && !proxies.length)
    throw new ImportError('Вставьте docker-compose.yml, Caddyfile или nginx.conf');

  let compose;
  try {
    compose = composeTexts.length ? parseCompose(composeTexts) : { services: [] };
  } catch (e) {
    throw e instanceof ComposeError ? new ImportError(e.message) : e;
  }

  const notes: string[] = [];
  const units = new Map<string, Unit>();
  const facts = new Map<string, ComposeService>(compose.services.map((s) => [s.name, s]));
  for (const s of compose.services) {
    const c: Classified =
      s.replicas === 0
        ? { role: { skip: 'infra' }, why: 'replicas: 0' }
        : classify({ name: s.name, image: s.image, command: s.command, env: s.env });
    units.set(s.name, { name: s.name, ...c, replicas: Math.max(1, s.replicas), published: s.published });
  }
  // Одноразовая задача, которую ждут до старта (миграции).
  for (const s of compose.services) {
    for (const d of s.dependsOn) {
      const u = units.get(d.name);
      if (d.completed && u && 'kind' in u.role) {
        u.role = { skip: 'job' };
        u.why = `${s.name} ждёт её завершения`;
      }
    }
  }

  const host = new Map<string, string>();
  for (const s of compose.services) for (const h of s.hostnames) if (!host.has(h)) host.set(h, s.name);

  // ---------- связи из compose ----------
  const g = new Graph();
  for (const s of compose.services) {
    for (const d of s.dependsOn) if (units.has(d.name)) g.add(s.name, d.name);
    for (const l of s.links) if (host.has(l)) g.add(s.name, host.get(l)!);
    const texts = [...Object.values(s.env), s.command].filter(Boolean);
    for (const [h, target] of host) {
      if (target !== s.name && texts.some((t) => mentions(t, h))) g.add(s.name, target);
    }
  }
  const traefik = compose.services.find((s) => /(^|\/)traefik$/.test(s.image?.split(':')[0] ?? ''));
  if (traefik) {
    for (const s of compose.services) {
      const routed = Object.entries(s.labels).some(
        ([k, v]) => (k === 'traefik.enable' && v === 'true') || k.startsWith('traefik.http.routers.'),
      );
      if (routed && s !== traefik) g.add(traefik.name, s.name);
    }
  }

  // ---------- связи из конфигов прокси ----------
  for (const { source, config } of proxies) {
    if (!config.upstreams.length) {
      notes.push(`В ${source} нет проксирования в контейнеры — файл пропущен`);
      continue;
    }
    const owner = proxyOwner(source, config, compose.services, units);
    if (!units.has(owner)) {
      units.set(owner, {
        name: owner,
        role: { kind: 'load-balancer' },
        why: `читает ${source}`,
        replicas: 1,
        published: true,
      });
    }
    for (const h of config.upstreams) {
      const target = host.get(h);
      if (target) {
        g.add(owner, target);
      } else if (h.includes('.') || h === 'localhost' || /^[\d:]+$/.test(h)) {
        notes.push(`${h} из ${source} — не контейнер compose, пропущен`);
      } else {
        const c = classify({ name: h, command: '', env: {} });
        units.set(h, { name: h, ...c, why: `апстрим в ${source}`, replicas: 1, published: false });
        host.set(h, h);
        g.add(owner, h);
      }
    }
  }

  // ---------- кого на схеме нет ----------
  const kindOf = (name: string): NodeKind | null => {
    const r = units.get(name)?.role;
    return r && 'kind' in r ? r.kind : null;
  };
  // Задачи и пулеры прозрачны: api → migrate → postgres превращается в api → postgres.
  for (const u of units.values()) {
    if ('kind' in u.role || u.role.skip === 'infra') continue;
    const preds = g.in(u.name);
    const succs = g.out(u.name);
    g.remove((a, b) => a === u.name || b === u.name);
    for (const p of preds) for (const s of succs) g.add(p, s);
  }
  g.remove((a, b) => kindOf(a) === null || kindOf(b) === null);

  // ---------- связи по смыслу ----------
  // Воркер, который зависит от очереди, — её потребитель: очередь отдаёт ему задачи.
  const consumers = g.remove((a, b) => kindOf(a) === 'worker' && kindOf(b) === 'queue');
  g.remove((a) => LEAF_KINDS.has(kindOf(a)!));
  g.remove((a, b) => RANK[kindOf(b)!] < RANK[kindOf(a)!]);
  for (const [w, q] of consumers) {
    g.add(q, w);
    notes.push(`${q} отдаёт задачи воркеру ${w}`);
  }

  // Кэш и база у одного сервиса: кэш ставим перед базой, в базу идут только промахи.
  const chained = new Set<string>();
  for (const name of units.keys()) {
    const outs = g.out(name);
    const caches = outs.filter((b) => kindOf(b) === 'cache');
    const stores = outs.filter((b) => STORE_KINDS.has(kindOf(b)!));
    if (caches.length !== 1 || !stores.length) continue;
    const cache = caches[0]!;
    for (const db of stores) {
      g.remove((a, b) => a === name && b === db);
      g.add(cache, db);
      chained.add(`${cache} стоит перед ${db}: в базу идут только промахи кэша`);
    }
  }
  notes.push(...chained);

  // Основная база и реплика у одного сервиса: читаем из реплики, пишем в основную.
  const only = new Map<string, 'read' | 'write'>();
  for (const name of units.keys()) {
    const outs = g.out(name);
    const primaries = outs.filter((b) => kindOf(b) === 'sql-primary');
    const replicas = outs.filter((b) => kindOf(b) === 'sql-replica');
    if (!primaries.length || !replicas.length) continue;
    for (const p of primaries) only.set(`${name}\u0000${p}`, 'write');
    for (const r of replicas) only.set(`${name}\u0000${r}`, 'read');
    notes.push(`${name} читает из ${replicas.join(', ')}, пишет в ${primaries.join(', ')}`);
  }

  // ---------- вход ----------
  const nodes = [...units.values()].filter((u) => 'kind' in u.role);
  const roots = nodes.filter((u) => !g.in(u.name).length);
  const entry =
    pick(roots.filter((u) => ENTRY_KINDS.has(kindOf(u.name)!))) ??
    pick(roots.filter((u) => kindOf(u.name) === 'service' && u.published)) ??
    pick(roots.filter((u) => kindOf(u.name) === 'service' && g.out(u.name).length)) ??
    pick(roots.filter((u) => kindOf(u.name) === 'service')) ??
    // Все сервисы в цикле, корней нет: вход — то, что опубликовано наружу.
    pick(nodes.filter((u) => ENTRY_KINDS.has(kindOf(u.name)!) || (u.published && kindOf(u.name) === 'service')));
  for (const u of entry ?? []) g.add(CLIENT, u.name);
  if (entry) notes.unshift(`Клиенты приходят в ${entry.map((u) => u.name).join(', ')}`);
  else if (!nodes.some((u) => RANK[kindOf(u.name)!] < RANK.cache))
    notes.unshift('В compose только базы, кэши и очереди — похоже на окружение для разработки: добавьте сервисы на доске')
  else notes.unshift('Не нашлось, куда приходят клиенты: соедините их со входом сами');

  breakCycles(g, notes);

  // ---------- документ ----------
  const ids = new Map<string, string>([[CLIENT, 'clients']]);
  const used = new Set(['clients']);
  for (const u of nodes) {
    const base = u.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'node';
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    ids.set(u.name, id);
  }
  const pos = layeredLayout([...ids.keys()], g.edges);
  const docNodes: Node[] = [
    { id: 'clients', kind: 'client', label: 'Клиенты', preset: DEFAULT_PRESET.client, pos: pos.get(CLIENT)! },
    ...nodes.map((u): Node => {
      const kind = kindOf(u.name)!;
      return {
        id: ids.get(u.name)!,
        kind,
        label: u.name.slice(0, 80),
        preset: DEFAULT_PRESET[kind],
        pos: pos.get(u.name)!,
        ...(u.replicas > 1 ? { params: { replicas: Math.min(u.replicas, 10000) } } : {}),
      };
    }),
  ];
  const docEdges = g.edges.map(([a, b], i): Edge => {
    const o = only.get(`${a}\u0000${b}`);
    return {
      id: `e${i + 1}`,
      from: `${ids.get(a)}:out`,
      to: `${ids.get(b)}:in`,
      ...(kindOf(b) === 'queue' ? { mode: 'parallel' as const } : {}),
      ...(o ? { only: o } : {}),
    };
  });

  const files = sources.filter((s) => s.text.trim()).map((s) => s.name);
  const doc: LoadlineDocument = {
    format: 'loadline',
    version: 1,
    meta: {
      title: (opts.title ?? compose.name ?? 'Импорт из compose').slice(0, 200),
      description:
        `Собрано из ${files.join(', ')}. Типы узлов угаданы по образам и именам, ` +
        'ёмкости и задержки — пресеты по умолчанию: поправьте их в инспекторе под свою систему.',
      createdAt: new Date().toISOString(),
    },
    traffic: { rps: 1000, readShare: 0.8, spike: 1 },
    nodes: docNodes.slice(0, 500),
    edges: docEdges.slice(0, 2000),
  };

  const services: ImportedService[] = [...units.values()].map((u) => ({
    name: u.name,
    kind: kindOf(u.name),
    ...('skip' in u.role
      ? { skipped: facts.get(u.name)?.replicas === 0 ? ('scaled-to-zero' as const) : u.role.skip }
      : {}),
    why: u.why,
    replicas: u.replicas,
  }));
  return { doc, services, notes };
}

function pick(us: Unit[]): Unit[] | null {
  return us.length ? us : null;
}

/** Какой контейнер читает этот конфиг: тот, что его монтирует, иначе прокси того же сорта. */
function proxyOwner(
  source: string,
  config: ProxyConfig,
  services: readonly ComposeService[],
  units: ReadonlyMap<string, Unit>,
): string {
  const file = basename(source);
  const mounted = services.find((s) => s.mounts.some((m) => basename(m) === file));
  if (mounted) return mounted.name;
  const isLb = (s: ComposeService): boolean => {
    const r = units.get(s.name)?.role;
    return !!r && 'kind' in r && r.kind === 'load-balancer';
  };
  const same = services.find((s) => isLb(s) && (s.image ?? s.name).includes(config.flavor));
  return (same ?? services.find(isLb))?.name ?? config.flavor;
}

/** Обход в глубину от клиентов: обратные связи замыкают циклы, движок их не считает — убираем. */
function breakCycles(g: Graph, notes: string[]): void {
  const state = new Map<string, 1 | 2>();
  const back: [string, string][] = [];
  const visit = (a: string): void => {
    state.set(a, 1);
    for (const b of g.out(a)) {
      if (state.get(b) === 1) back.push([a, b]);
      else if (!state.has(b)) visit(b);
    }
    state.set(a, 2);
  };
  visit(CLIENT);
  for (const [a] of g.edges) if (!state.has(a)) visit(a);
  for (const [a, b] of back) {
    g.remove((x, y) => x === a && y === b);
    notes.push(`Связь ${a} → ${b} убрана: она замыкала цикл`);
  }
}
