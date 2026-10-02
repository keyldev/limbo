import type { LoadlineDocument } from '@loadline/model';
import { migrate, UnsupportedFormatError } from './migrate.js';

/**
 * Проверка документа на клиенте. Повторяет ограничения spec/loadline.schema.json,
 * чтобы файл, ссылка или автосохранение не падали в движке, а сервер не отклонял
 * то, что приложение считает нормальным. Сервер по-прежнему проверяет схемой сам.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PORT = /^([A-Za-z0-9_-]{1,64}):(in|out)$/;
const KINDS = new Set([
  'client',
  'cdn',
  'load-balancer',
  'api-gateway',
  'service',
  'worker',
  'cache',
  'sql-primary',
  'sql-replica',
  'nosql',
  'queue',
  'object-storage',
  'search',
]);

/** Лимиты из схемы. Меняются вместе с ней. */
export const DOCUMENT_LIMITS = { nodes: 500, edges: 2000, label: 80, title: 200, description: 4000 } as const;

export class InvalidDocumentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Схема не прошла проверку: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`);
    this.name = 'InvalidDocumentError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function onlyKeys(o: Obj, allowed: readonly string[], where: string, out: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) out.push(`${where}: лишнее поле «${k}»`);
  }
}

function num(
  o: Obj,
  key: string,
  where: string,
  out: string[],
  opts: { min?: number; max?: number; gtZero?: boolean; int?: boolean; required?: boolean } = {},
): void {
  const v = o[key];
  if (v === undefined) {
    if (opts.required) out.push(`${where}.${key}: обязательное поле`);
    return;
  }
  if (!isNum(v)) {
    out.push(`${where}.${key}: нужно число`);
    return;
  }
  if (opts.int && !Number.isInteger(v)) out.push(`${where}.${key}: нужно целое число`);
  if (opts.gtZero && v <= 0) out.push(`${where}.${key}: должно быть больше 0`);
  if (opts.min !== undefined && v < opts.min) out.push(`${where}.${key}: не меньше ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) out.push(`${where}.${key}: не больше ${opts.max}`);
}

function str(o: Obj, key: string, where: string, out: string[], max: number): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v !== 'string') out.push(`${where}.${key}: нужна строка`);
  else if (v.length > max) out.push(`${where}.${key}: не длиннее ${max} символов`);
}

/** Список проблем документа текущей версии. Пустой список — документ в порядке. */
export function validateDocument(doc: unknown): string[] {
  const out: string[] = [];
  if (!isObj(doc)) return ['Это не объект'];
  onlyKeys(doc, ['format', 'version', 'meta', 'traffic', 'nodes', 'edges'], 'схема', out);

  if (doc['meta'] !== undefined) {
    const meta = doc['meta'];
    if (!isObj(meta)) out.push('meta: нужен объект');
    else {
      onlyKeys(meta, ['title', 'description', 'createdAt'], 'meta', out);
      str(meta, 'title', 'meta', out, DOCUMENT_LIMITS.title);
      str(meta, 'description', 'meta', out, DOCUMENT_LIMITS.description);
      str(meta, 'createdAt', 'meta', out, 64);
    }
  }

  const traffic = doc['traffic'];
  if (!isObj(traffic)) out.push('traffic: обязательный объект');
  else {
    onlyKeys(traffic, ['rps', 'readShare', 'spike'], 'traffic', out);
    num(traffic, 'rps', 'traffic', out, { required: true, min: 0, max: 100_000_000 });
    num(traffic, 'readShare', 'traffic', out, { min: 0, max: 1 });
    num(traffic, 'spike', 'traffic', out, { min: 1, max: 100 });
  }

  const nodeIds = new Set<string>();
  const nodes = doc['nodes'];
  if (!Array.isArray(nodes)) out.push('nodes: обязательный массив');
  else {
    if (nodes.length > DOCUMENT_LIMITS.nodes) out.push(`nodes: не больше ${DOCUMENT_LIMITS.nodes} узлов`);
    nodes.forEach((n: unknown, i) => {
      const where = `nodes[${i}]`;
      if (!isObj(n)) {
        out.push(`${where}: нужен объект`);
        return;
      }
      onlyKeys(n, ['id', 'kind', 'label', 'preset', 'pos', 'params'], where, out);
      const id = n['id'];
      if (typeof id !== 'string' || !ID.test(id)) out.push(`${where}.id: латиница, цифры, - и _, до 64 символов`);
      else if (nodeIds.has(id)) out.push(`${where}.id: повтор «${id}»`);
      else nodeIds.add(id);
      if (typeof n['kind'] !== 'string' || !KINDS.has(n['kind'])) out.push(`${where}.kind: неизвестный тип`);
      str(n, 'label', where, out, DOCUMENT_LIMITS.label);
      str(n, 'preset', where, out, DOCUMENT_LIMITS.label);
      const pos = n['pos'];
      if (!isObj(pos)) out.push(`${where}.pos: обязательный объект`);
      else {
        onlyKeys(pos, ['x', 'y'], `${where}.pos`, out);
        num(pos, 'x', `${where}.pos`, out, { required: true });
        num(pos, 'y', `${where}.pos`, out, { required: true });
      }
      const p = n['params'];
      if (p !== undefined) {
        if (!isObj(p)) out.push(`${where}.params: нужен объект`);
        else {
          const pw = `${where}.params`;
          onlyKeys(p, ['replicas', 'capacityRps', 'baseLatencyMs', 'hitRatio', 'costPerReplicaUsd', 'outage'], pw, out);
          num(p, 'replicas', pw, out, { int: true, min: 1, max: 10_000 });
          num(p, 'capacityRps', pw, out, { gtZero: true });
          num(p, 'baseLatencyMs', pw, out, { min: 0 });
          num(p, 'hitRatio', pw, out, { min: 0, max: 1 });
          num(p, 'costPerReplicaUsd', pw, out, { min: 0 });
          if (p['outage'] !== undefined && typeof p['outage'] !== 'boolean') out.push(`${pw}.outage: нужно true или false`);
        }
      }
    });
  }

  const edges = doc['edges'];
  if (!Array.isArray(edges)) out.push('edges: обязательный массив');
  else {
    if (edges.length > DOCUMENT_LIMITS.edges) out.push(`edges: не больше ${DOCUMENT_LIMITS.edges} связей`);
    const edgeIds = new Set<string>();
    edges.forEach((e: unknown, i) => {
      const where = `edges[${i}]`;
      if (!isObj(e)) {
        out.push(`${where}: нужен объект`);
        return;
      }
      onlyKeys(e, ['id', 'from', 'to', 'mode'], where, out);
      const id = e['id'];
      if (typeof id !== 'string' || !ID.test(id)) out.push(`${where}.id: латиница, цифры, - и _, до 64 символов`);
      else if (edgeIds.has(id)) out.push(`${where}.id: повтор «${id}»`);
      else edgeIds.add(id);
      for (const end of ['from', 'to'] as const) {
        const ref = e[end];
        const m = typeof ref === 'string' ? PORT.exec(ref) : null;
        if (!m) out.push(`${where}.${end}: ссылка на порт вида узел:in или узел:out`);
        else if (Array.isArray(nodes) && !nodeIds.has(m[1]!)) out.push(`${where}.${end}: нет узла «${m[1]}»`);
      }
      if (e['mode'] !== undefined && e['mode'] !== 'sequential' && e['mode'] !== 'parallel') {
        out.push(`${where}.mode: sequential или parallel`);
      }
    });
  }

  return out;
}

/**
 * Документ из чужого источника (файл, ссылка, автосохранение): миграция до текущей версии
 * и проверка. Бросает UnsupportedFormatError или InvalidDocumentError с понятным текстом.
 */
export function parseDocument(raw: unknown): LoadlineDocument {
  const doc = migrate(raw);
  const problems = validateDocument(doc);
  if (problems.length > 0) throw new InvalidDocumentError(problems);
  return doc;
}

export { UnsupportedFormatError };
