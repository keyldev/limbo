import { describe, expect, it } from 'vitest';
import { latencyPercentile, meanLatency, percentileOfSorted, RHO_CAP, utilization } from './formulas.js';
import { createRng, sampleExp } from './rng.js';

describe('формулы', () => {
  it('ρ = λ / (c · μ)', () => {
    expect(utilization(500, 2, 1000)).toBe(0.25);
    expect(utilization(0, 0, 1000)).toBe(0);
    expect(utilization(10, 0, 1000)).toBe(Infinity);
  });

  it('W = t₀ / (1 − ρ) и ограничение ρ', () => {
    expect(meanLatency(10, 0)).toBe(10);
    expect(meanLatency(10, 0.5)).toBe(20);
    expect(meanLatency(10, 5)).toBeCloseTo(10 / (1 - RHO_CAP));
  });

  it('перцентили экспоненты: p95 ≈ 3,0·W, p99 ≈ 4,6·W', () => {
    expect(latencyPercentile(10, 0.95)).toBeCloseTo(29.96, 1);
    expect(latencyPercentile(10, 0.99)).toBeCloseTo(46.05, 1);
  });

  it('перцентиль по выборке', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileOfSorted(xs, 0.95)).toBe(95);
    expect(percentileOfSorted([], 0.5)).toBe(0);
  });

  it('генератор детерминирован, среднее экспоненты сходится', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(a()).toBe(b());
    const rng = createRng(7);
    let s = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) s += sampleExp(rng, 10);
    expect(s / n).toBeCloseTo(10, 0);
  });
});
