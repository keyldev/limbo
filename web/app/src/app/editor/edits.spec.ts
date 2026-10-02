import type { LoadlineDocument } from '@loadline/model';
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
} from './edits';
import { History } from './history';

const doc: LoadlineDocument = {
  format: 'loadline',
  version: 1,
  traffic: { rps: 100 },
  nodes: [
    { id: 'a', kind: 'client', pos: { x: 0, y: 0 } },
    { id: 'b', kind: 'service', pos: { x: 200, y: 0 } },
    { id: 'c', kind: 'cache', pos: { x: 400, y: 0 } },
  ],
  edges: [{ id: 'e1', from: 'a:out', to: 'b:in' }],
};

describe('правки схемы', () => {
  it('перемещение меняет только сдвинутые узлы', () => {
    const next = moveNodes(doc, [{ id: 'b', pos: { x: 210, y: 5 } }]);
    expect(next.nodes[1]!.pos).toEqual({ x: 210, y: 5 });
    expect(next.nodes[0]).toBe(doc.nodes[0]);
  });

  it('перемещение на то же место не создаёт новый документ', () => {
    expect(moveNodes(doc, [{ id: 'a', pos: { x: 0, y: 0 } }])).toBe(doc);
  });

  it('связь создаётся только из выхода во вход, без дублей и петель', () => {
    expect(addEdge(doc, { from: 'b:out', to: 'c:in' }).edges).toHaveLength(2);
    expect(addEdge(doc, { from: 'a:out', to: 'b:in' })).toBe(doc);
    expect(addEdge(doc, { from: 'b:out', to: 'b:in' })).toBe(doc);
    expect(addEdge(doc, { from: 'b:in', to: 'c:out' })).toBe(doc);
    expect(addEdge(doc, { from: 'b:out', to: 'zz:in' })).toBe(doc);
  });

  it('id новой связи не совпадает с существующими', () => {
    const next = addEdge(doc, { from: 'b:out', to: 'c:in' });
    expect(new Set(next.edges.map((e) => e.id)).size).toBe(2);
  });

  it('переподключение меняет конец связи и сохраняет id', () => {
    const next = reconnectEdge(doc, { edgeId: 'e1', from: 'a:out', to: 'c:in' });
    expect(next.edges).toEqual([{ id: 'e1', from: 'a:out', to: 'c:in' }]);
  });

  it('удаление узла убирает его связи', () => {
    const next = removeNode(doc, 'b');
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(next.edges).toEqual([]);
  });

  it('удаление связи', () => {
    expect(removeEdge(doc, 'e1').edges).toEqual([]);
    expect(removeEdge(doc, 'nope')).toBe(doc);
  });
});

describe('правила связей и новые узлы', () => {
  it('связь в клиента и связь, замыкающая цикл, запрещены с объяснением', () => {
    const chain = addEdge(doc, { from: 'b:out', to: 'c:in' });
    expect(connectProblem(chain, { from: 'b:out', to: 'a:in' })).toMatch(/клиент/);
    expect(connectProblem(chain, { from: 'c:out', to: 'b:in' })).toMatch(/цикл/);
    expect(addEdge(chain, { from: 'c:out', to: 'b:in' })).toBe(chain);
  });

  it('переподключение не считает циклом саму переносимую связь', () => {
    expect(reconnectEdge(doc, { edgeId: 'e1', from: 'a:out', to: 'c:in' })).not.toBe(doc);
  });

  it('новый узел получает свободное имя и пресет своего типа', () => {
    const one = addNode(doc, 'service', { x: 10, y: 20 });
    const two = addNode(one.doc, 'service', { x: 0, y: 0 });
    expect(one.node).toMatchObject({
      id: 'service',
      label: 'service',
      preset: 'service.small',
      pos: { x: 10, y: 20 },
    });
    expect(two.node.id).toBe('service-2');
  });

  it('правка параметров сливается с прежними, пустая правка не создаёт документ', () => {
    const r = updateNode(doc, 'b', { params: { replicas: 3 } });
    const both = updateNode(r, 'b', { params: { outage: true }, label: 'api' });
    expect(both.nodes[1]).toMatchObject({ label: 'api', params: { replicas: 3, outage: true } });
    expect(updateNode(r, 'b', { params: { replicas: 3 } })).toBe(r);
  });

  it('режим вызова связи', () => {
    const p = setEdgeMode(doc, 'e1', 'parallel');
    expect(p.edges[0]!.mode).toBe('parallel');
    expect(setEdgeMode(p, 'e1', 'parallel')).toBe(p);
  });

  it('какие запросы несёт связь', () => {
    const r = setEdgeOnly(doc, 'e1', 'read');
    expect(r.edges[0]!.only).toBe('read');
    expect(setEdgeOnly(r, 'e1', 'read')).toBe(r);
    const all = setEdgeOnly(r, 'e1', undefined);
    expect('only' in all.edges[0]!).toBe(false);
  });
});

describe('история', () => {
  it('правки с одним ключом подряд склеиваются в один шаг', () => {
    const h = new History<string>();
    h.record('a', 'name', 0);
    h.record('ab', 'name', 300);
    h.record('abc', 'name', 600);
    expect(h.undo('abcd')).toBe('a');
    expect(h.canUndo()).toBe(false);
  });

  it('отменяет и повторяет по шагам, новая правка сбрасывает повтор', () => {
    const h = new History<number>();
    h.record(1);
    h.record(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBe(2);
    h.record(2);
    expect(h.canRedo()).toBe(false);
  });
});
