import type { Position } from '@loadline/model';

/** Шаг сетки как в готовых сценариях: колонка — 264, строка — 216. */
const COL = 264;
const ROW = 216;

/**
 * Раскладка слоями слева направо: слой узла — длина самого длинного пути до него.
 * Граф без циклов (их рвут до раскладки). Внутри слоя узлы стоят по среднему положению
 * предков — так меньше пересечений. Узлы без связей ложатся отдельной строкой снизу.
 */
export function layeredLayout(
  ids: readonly string[],
  edges: readonly (readonly [string, string])[],
): Map<string, Position> {
  const preds = new Map(ids.map((id) => [id, [] as string[]]));
  const succs = new Map(ids.map((id) => [id, [] as string[]]));
  for (const [a, b] of edges) {
    succs.get(a)?.push(b);
    preds.get(b)?.push(a);
  }

  // Кан: порядок топологический, слой — максимум по предкам + 1.
  const layer = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, preds.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const l = layer.get(id) ?? 0;
    for (const s of succs.get(id)!) {
      layer.set(s, Math.max(layer.get(s) ?? 0, l + 1));
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }

  const connected = ids.filter((id) => preds.get(id)!.length + succs.get(id)!.length > 0);
  const loose = ids.filter((id) => !connected.includes(id));
  const columns: string[][] = [];
  for (const id of connected) (columns[layer.get(id) ?? 0] ??= []).push(id);

  const pos = new Map<string, Position>();
  let tallest = 0;
  columns.forEach((col, x) => {
    if (x > 0) {
      const center = (id: string): number => {
        const ys = preds.get(id)!.map((p) => pos.get(p)?.y ?? 0);
        return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 0;
      };
      col.sort((a, b) => center(a) - center(b));
    }
    col.forEach((id, i) => pos.set(id, { x: x * COL, y: (i - (col.length - 1) / 2) * ROW }));
    tallest = Math.max(tallest, col.length);
  });

  const bottom = ((tallest - 1) / 2 + 1.5) * ROW;
  loose.forEach((id, i) => pos.set(id, { x: (i + 1) * COL, y: bottom }));
  return pos;
}
