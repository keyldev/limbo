import type { LoadlineDocument, Node, NodeKind, NodeParams, Position } from '@loadline/model';
import {
  nodeIdOfPort,
  type BoardConnect,
  type BoardMove,
  type BoardReconnect,
} from '../board/board-contract';
import { kindInfo } from '../catalog/kinds';

/**
 * Правки схемы — чистые функции над неизменяемым документом.
 * Возвращают тот же документ, если правка не нужна или недопустима:
 * по равенству ссылок приложение понимает, что записывать в историю нечего.
 */

export function moveNodes(doc: LoadlineDocument, moves: readonly BoardMove[]): LoadlineDocument {
  const byId = new Map(moves.map((m) => [m.id, m.pos]));
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    const pos = byId.get(n.id);
    if (!pos || (pos.x === n.pos.x && pos.y === n.pos.y)) return n;
    changed = true;
    return { ...n, pos: { x: pos.x, y: pos.y } };
  });
  return changed ? { ...doc, nodes } : doc;
}

/** Замкнёт ли связь from → to цикл: да, если from достижим из to. */
function wouldCycle(
  doc: LoadlineDocument,
  from: string,
  to: string,
  ignoreEdgeId?: string,
): boolean {
  const adj = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (e.id === ignoreEdgeId) continue;
    const a = nodeIdOfPort(e.from);
    adj.set(a, [...(adj.get(a) ?? []), nodeIdOfPort(e.to)]);
  }
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === from) return true;
    for (const next of adj.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Почему связь нельзя создать, или null, если можно.
 * Связь идёт из выхода во вход, между разными существующими узлами, без дублей и циклов;
 * в клиента связи не входят: он только отправляет трафик.
 */
export function connectProblem(
  doc: LoadlineDocument,
  c: BoardConnect,
  ignoreEdgeId?: string,
): string | null {
  if (!c.from.endsWith(':out') || !c.to.endsWith(':in'))
    return 'тянуть нужно из правого порта в левый.';
  const from = nodeIdOfPort(c.from);
  const to = nodeIdOfPort(c.to);
  if (from === to) return 'узел не может звать сам себя.';
  const target = doc.nodes.find((n) => n.id === to);
  if (!target || !doc.nodes.some((n) => n.id === from)) return 'такого узла нет.';
  if (target.kind === 'client') return 'клиенты только отправляют трафик, в них связь не входит.';
  if (doc.edges.some((e) => e.id !== ignoreEdgeId && e.from === c.from && e.to === c.to)) {
    return 'такая связь уже есть.';
  }
  if (wouldCycle(doc, from, to, ignoreEdgeId))
    return 'она замкнула бы цикл, а циклы модель не считает.';
  return null;
}

export function addEdge(doc: LoadlineDocument, c: BoardConnect): LoadlineDocument {
  if (connectProblem(doc, c)) return doc;
  const used = new Set(doc.edges.map((e) => e.id));
  let i = doc.edges.length + 1;
  while (used.has(`e${i}`)) i++;
  return { ...doc, edges: [...doc.edges, { id: `e${i}`, from: c.from, to: c.to }] };
}

export function reconnectEdge(doc: LoadlineDocument, r: BoardReconnect): LoadlineDocument {
  const edge = doc.edges.find((e) => e.id === r.edgeId);
  if (!edge || (edge.from === r.from && edge.to === r.to)) return doc;
  if (connectProblem(doc, r, r.edgeId)) return doc;
  return {
    ...doc,
    edges: doc.edges.map((e) => (e.id === r.edgeId ? { ...e, from: r.from, to: r.to } : e)),
  };
}

export function removeEdge(doc: LoadlineDocument, edgeId: string): LoadlineDocument {
  const edges = doc.edges.filter((e) => e.id !== edgeId);
  return edges.length === doc.edges.length ? doc : { ...doc, edges };
}

/** Удаляет узел вместе со всеми его связями. */
export function removeNode(doc: LoadlineDocument, nodeId: string): LoadlineDocument {
  const nodes = doc.nodes.filter((n) => n.id !== nodeId);
  if (nodes.length === doc.nodes.length) return doc;
  const edges = doc.edges.filter(
    (e) => nodeIdOfPort(e.from) !== nodeId && nodeIdOfPort(e.to) !== nodeId,
  );
  return { ...doc, nodes, edges };
}

/** Новый узел с уникальными id и именем: service, service-2, service-3… */
export function addNode(
  doc: LoadlineDocument,
  kind: NodeKind,
  pos: Position,
): { doc: LoadlineDocument; node: Node } {
  const info = kindInfo(kind);
  const taken = new Set(doc.nodes.flatMap((n) => [n.id, n.label ?? n.id]));
  let name = info.slug;
  for (let i = 2; taken.has(name); i++) name = `${info.slug}-${i}`;
  const node: Node = {
    id: name,
    kind,
    label: name,
    preset: info.preset,
    pos: { x: pos.x, y: pos.y },
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, node };
}

export interface NodePatch {
  label?: string;
  params?: Partial<NodeParams>;
}

export function updateNode(doc: LoadlineDocument, id: string, patch: NodePatch): LoadlineDocument {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return doc;
  const labelChanged = patch.label !== undefined && patch.label !== (node.label ?? node.id);
  const params = patch.params ?? {};
  const paramsChanged = Object.entries(params).some(
    ([k, v]) => node.params?.[k as keyof NodeParams] !== v,
  );
  if (!labelChanged && !paramsChanged) return doc;
  const next: Node = {
    ...node,
    ...(labelChanged ? { label: patch.label } : {}),
    ...(paramsChanged ? { params: { ...node.params, ...params } } : {}),
  };
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? next : n)) };
}

export function setEdgeMode(
  doc: LoadlineDocument,
  edgeId: string,
  mode: 'sequential' | 'parallel',
): LoadlineDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge || (edge.mode ?? 'sequential') === mode) return doc;
  return { ...doc, edges: doc.edges.map((e) => (e.id === edgeId ? { ...e, mode } : e)) };
}
