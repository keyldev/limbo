import { YamlError, parseYaml } from './yaml.js';

/** Сервис из docker-compose — только то, что нужно для схемы. */
export interface ComposeService {
  name: string;
  image?: string;
  /** command и entrypoint одной строкой. */
  command: string;
  env: Record<string, string>;
  dependsOn: { name: string; completed: boolean }[];
  links: string[];
  /** Под какими именами контейнер виден в сети: имя сервиса, container_name, hostname, алиасы. */
  hostnames: string[];
  replicas: number;
  /** Порты опубликованы наружу: кандидат во вход системы. */
  published: boolean;
  labels: Record<string, string>;
  /** Что примонтировано с хоста: ./Caddyfile:/etc/caddy/Caddyfile → ./Caddyfile. */
  mounts: string[];
}

export interface ComposeFile {
  name?: string;
  services: ComposeService[];
}

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Подстановка переменных, как её сделает compose без .env: ${DB_HOST:-postgres} → postgres,
 * ${API_DOMAIN} → пусто. Значения по умолчанию — часто как раз имена соседних сервисов.
 */
export function interpolate(s: string): string {
  return s
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?(?::?[?+][^}]*)?\}/g, (_, def) => def ?? '')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
}

/** environment бывает списком «KEY=value» и словарём. */
function envOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = str(item);
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i)] = interpolate(s.slice(i + 1));
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = interpolate(str(val));
  }
  return out;
}

/** labels — тоже список или словарь. */
function labelsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const item of v) {
      const [k, ...rest] = str(item).split('=');
      if (k) out[k] = rest.join('=');
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = str(val);
  }
  return out;
}

function dependsOf(v: unknown): ComposeService['dependsOn'] {
  if (Array.isArray(v)) return v.map((d) => ({ name: str(d), completed: false })).filter((d) => d.name);
  if (!isObj(v)) return [];
  return Object.entries(v).map(([name, cond]) => ({
    name,
    completed: isObj(cond) && cond['condition'] === 'service_completed_successfully',
  }));
}

function commandOf(v: unknown): string {
  return Array.isArray(v) ? v.map(str).join(' ') : str(v);
}

function mountsOf(v: unknown): string[] {
  return list(v)
    .map((m) => (isObj(m) ? str(m['source']) : str(m).split(':')[0]!))
    .filter((m) => m.startsWith('.') || m.startsWith('/') || m.includes('/'));
}

function aliasesOf(v: unknown): string[] {
  if (!isObj(v)) return [];
  return Object.values(v).flatMap((net) => (isObj(net) ? list(net['aliases']).map(str) : []));
}

function replicasOf(svc: Obj): number {
  const deploy = isObj(svc['deploy']) ? svc['deploy'] : {};
  const n = Number(deploy['replicas'] ?? svc['scale'] ?? 1);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 1;
}

/**
 * Читает docker-compose.yml. Несколько файлов (compose.yaml + compose.override.yaml)
 * склеиваются как у compose: поля сервиса из следующего файла заменяют прежние.
 */
export function parseCompose(texts: readonly string[]): ComposeFile {
  const merged = new Map<string, Obj>();
  let name: string | undefined;
  for (const text of texts) {
    let root: unknown;
    try {
      root = parseYaml(text);
    } catch (e) {
      if (e instanceof YamlError) throw new ComposeError(`YAML не разобрался: ${e.message}`);
      throw e;
    }
    if (!isObj(root) || !isObj(root['services']))
      throw new ComposeError('В файле нет раздела services — это не docker-compose');
    if (typeof root['name'] === 'string') name = root['name'];
    for (const [svcName, svc] of Object.entries(root['services'])) {
      if (isObj(svc)) merged.set(svcName, { ...merged.get(svcName), ...svc });
    }
  }

  const services = [...merged].map(([svcName, svc]): ComposeService => {
    const hostnames = [
      svcName,
      str(svc['container_name']),
      str(svc['hostname']),
      ...aliasesOf(svc['networks']),
    ].filter(Boolean);
    const image = str(svc['image']) || undefined;
    return {
      name: svcName,
      ...(image ? { image: interpolate(image) || image } : {}),
      command: interpolate(`${commandOf(svc['entrypoint'])} ${commandOf(svc['command'])}`.trim()),
      env: envOf(svc['environment']),
      dependsOn: dependsOf(svc['depends_on']),
      links: list(svc['links']).map((l) => str(l).split(':')[0]!).filter(Boolean),
      hostnames: [...new Set(hostnames)],
      replicas: replicasOf(svc),
      published: list(svc['ports']).length > 0,
      labels: labelsOf(svc['labels']),
      mounts: mountsOf(svc['volumes']),
    };
  });
  return { ...(name ? { name } : {}), services };
}
