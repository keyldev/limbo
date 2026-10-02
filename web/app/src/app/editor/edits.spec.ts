import type { LoadlineDocument } from '@loadline/model';
import { addEdge, moveNodes, reconnectEdge, removeEdge, removeNode } from './edits';
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

describe('история', () => {
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
