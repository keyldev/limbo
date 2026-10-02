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
export function percentileOfSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}
