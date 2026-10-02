import type { LoadlineDocument } from '@loadline/model';
import {
  nodeIdOfPort,
  type BoardConnect,
  type BoardMove,
  type BoardReconnect,
} from '../board/board-contract';

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

/** Связь допустима: из выхода во вход, между разными существующими узлами, без дублей. */
export function canConnect(doc: LoadlineDocument, c: BoardConnect, ignoreEdgeId?: string): boolean {
  if (!c.from.endsWith(':out') || !c.to.endsWith(':in')) return false;
  const from = nodeIdOfPort(c.from);
  const to = nodeIdOfPort(c.to);
  if (from === to) return false;
  const ids = new Set(doc.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return false;
  return !doc.edges.some((e) => e.id !== ignoreEdgeId && e.from === c.from && e.to === c.to);
}

export function addEdge(doc: LoadlineDocument, c: BoardConnect): LoadlineDocument {
  if (!canConnect(doc, c)) return doc;
  const used = new Set(doc.edges.map((e) => e.id));
  let i = doc.edges.length + 1;
  while (used.has(`e${i}`)) i++;
  return { ...doc, edges: [...doc.edges, { id: `e${i}`, from: c.from, to: c.to }] };
}

export function reconnectEdge(doc: LoadlineDocument, r: BoardReconnect): LoadlineDocument {
  const edge = doc.edges.find((e) => e.id === r.edgeId);
  if (!edge || (edge.from === r.from && edge.to === r.to)) return doc;
  if (!canConnect(doc, r, r.edgeId)) return doc;
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
