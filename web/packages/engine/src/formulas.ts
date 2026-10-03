/**
 * Формулы модели. Каждая функция — одна формула со страницы «Как считаем».
 *
 *   ρ   = λ / (c · μ)          загрузка
 *   W   = t₀ / (1 − ρ)         среднее время ответа узла (M/M/1 на группу реплик)
 *   T_p = W · ln(1 / (1 − p))  перцентиль времени ответа узла
 */

/** Предел загрузки для формулы задержки: при ρ → 1 задержка уходит в бесконечность. */
export const RHO_CAP = 0.99;

/** Загрузка узла ρ = λ / (c · μ). */
export function utilization(lambda: number, replicas: number, capacityRps: number): number {
  const total = replicas * capacityRps;
  if (total <= 0) return lambda > 0 ? Infinity : 0;
  return lambda / total;
}

/** Среднее время ответа W = t₀ / (1 − ρ), ρ ограничена RHO_CAP. */
export function meanLatency(baseLatencyMs: number, rho: number): number {
  const r = Math.min(Math.max(rho, 0), RHO_CAP);
  return baseLatencyMs / (1 - r);
}

/** Перцентиль p (0..1) экспоненциального времени ответа со средним W. */
export function latencyPercentile(meanMs: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return meanMs * Math.log(1 / (1 - p));
}

/** Перцентиль p по отсортированному массиву (метод ближайшего ранга). */
export function percentileOfSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}

/** Ранг перцентиля p в выборке из n значений (метод ближайшего ранга, как в percentileOfSorted). */
function rankOf(p: number, n: number): number {
  return Math.min(Math.max(Math.ceil(p * n) - 1, 0), n - 1);
}

/**
 * Перцентили ps по выборке без полной сортировки: quickselect, O(n) вместо O(n log n).
 * Значения те же, что у percentileOfSorted по отсортированной копии. Переставляет values.
 */
export function percentilesOf(values: Float64Array, ps: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return ps.map(() => 0);
  // От большего ранга к меньшему: после выбора ранга k слева лежат k наименьших значений,
  // и следующий, меньший ранг ищется уже только среди них.
  const order = ps.map((p, i) => ({ i, k: rankOf(p, n) })).sort((a, b) => b.k - a.k);
  const out = new Array<number>(ps.length);
  let hi = n - 1;
  for (const { i, k } of order) {
    selectInPlace(values, 0, Math.max(hi, k), k);
    out[i] = values[k]!;
    hi = k - 1;
  }
  return out;
}

/** Ставит на место k значение, которое стояло бы там после сортировки отрезка [lo, hi]. */
function selectInPlace(a: Float64Array, lo: number, hi: number, k: number): void {
  while (hi > lo) {
    // Опорный элемент — медиана трёх: на отсортированных и почти отсортированных данных не деградирует.
    const x = a[lo]!;
    const y = a[(lo + hi) >>> 1]!;
    const z = a[hi]!;
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y;
    // Разбиение Хоара: равные опорному расходятся в обе стороны, повторы не делают отрезки неравными.
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i++;
        j--;
      }
    }
    // [lo, j] ≤ pivot, (j, i) = pivot, [i, hi] ≥ pivot.
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}
