import type { Workload } from './workload.js';
import { YamlError, parseYaml } from './yaml.js';

/** Сервис из docker-compose. */
export type ComposeService = Workload;

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

/** Порты контейнера из ports и expose: «127.0.0.1:5080:8080/tcp» → 8080, { target: 5432 } → 5432. */
function portsOf(svc: Obj): string[] {
  const out = [...list(svc['ports']), ...list(svc['expose'])].map((p) => {
    if (isObj(p)) return str(p['target']);
    const s = str(p).split('/')[0]!;
    return s.slice(s.lastIndexOf(':') + 1).split('-')[0]!;
  });
  return [...new Set(out.filter((p) => /^\d+$/.test(p)))];
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
      ports: portsOf(svc),
      published: list(svc['ports']).length > 0,
      labels: labelsOf(svc['labels']),
      mounts: mountsOf(svc['volumes']),
    };
  });
  return { ...(name ? { name } : {}), services };
}
