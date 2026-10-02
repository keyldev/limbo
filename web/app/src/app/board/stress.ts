import type { Edge, LoadlineDocument, Node, NodeKind } from '@loadline/model';

export const STRESS_SCENARIO = '__stress-200';

const COLUMN_KINDS: NodeKind[] = [
  'load-balancer',
  'api-gateway',
  'service',
  'cache',
  'service',
  'queue',
  'worker',
  'nosql',
  'sql-primary',
];

/**
 * Синтетическая схема на 200 узлов для замера плавности доски (критерий ADR 0003).
 * Дерево, а не произвольный граф: у каждого узла один родитель в предыдущей колонке,
 * иначе сэмплирование путей в движке разрастается и мешает замеру самой доски.
 */
export function stressDocument(count = 200): LoadlineDocument {
  const perColumn = Math.ceil((count - 1) / COLUMN_KINDS.length);
  const nodes: Node[] = [{ id: 'client', kind: 'client', pos: { x: 0, y: (perColumn * 96) / 2 } }];
  const edges: Edge[] = [];

  // Детерминированный «случайный» выбор родителя: схема одинакова при каждом запуске.
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  let prev = ['client'];
  for (let col = 0; col < COLUMN_KINDS.length && nodes.length < count; col++) {
    const column: string[] = [];
    for (let row = 0; row < perColumn && nodes.length < count; row++) {
      const id = `n${col}-${row}`;
      nodes.push({
        id,
        kind: COLUMN_KINDS[col]!,
        pos: { x: (col + 1) * 264, y: row * 96 },
        params: { replicas: 40 },
      });
      const parent = prev[Math.floor(next() * prev.length)]!;
      edges.push({ id: `e-${id}`, from: `${parent}:out`, to: `${id}:in` });
      column.push(id);
    }
    prev = column;
  }

  return {
    format: 'loadline',
    version: 1,
    meta: { title: `Стресс: ${nodes.length} узлов` },
    traffic: { rps: 2000, readShare: 0.8, spike: 1 },
    nodes,
    edges,
  };
}
