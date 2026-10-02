/** Компактное число: 950, 1.2k, 18k, ∞. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 10) return `${Math.round(n)}`;
  return n.toFixed(n > 0 && n < 1 ? 2 : 0);
}

export function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} с` : `${Math.round(n)} мс`;
}

/** Время симуляции: 01:05. */
export function fmtClock(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function pct(rho: number): string {
  return Number.isFinite(rho) ? `${Math.round(rho * 100)}%` : '∞';
}

/** Ошибки с точностью, которая видна: 0.04% и 12.5%. */
export function errorPct(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.01 ? 2 : 1)}%`;
}

/** Трафик на логарифмической шкале слайдера: 50 → 20 000 rps на 0 → 1000. */
export const RPS_MIN = 50;
export const RPS_MAX = 20_000;

export function rpsToSlider(rps: number): number {
  const r = Math.min(Math.max(rps, RPS_MIN), RPS_MAX);
  return Math.round((Math.log(r / RPS_MIN) / Math.log(RPS_MAX / RPS_MIN)) * 1000);
}

export function sliderToRps(s: number): number {
  const r = RPS_MIN * Math.pow(RPS_MAX / RPS_MIN, s / 1000);
  return r > 1000 ? Math.round(r / 100) * 100 : r > 200 ? Math.round(r / 10) * 10 : Math.round(r);
}
