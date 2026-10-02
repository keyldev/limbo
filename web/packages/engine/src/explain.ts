import type { NodeMetrics, ResolvedNode } from './simulate.js';
import { RHO_CAP } from './formulas.js';

/** Одна формула с подставленными значениями — то, что показывается по клику на число. */
export interface Explanation {
  metric: 'rho' | 'meanLatency' | 'p95' | 'p99';
  formula: string;
  substituted: string;
  result: string;
}

const ms = (x: number) => `${x.toFixed(1)} мс`;
const num = (x: number) => (Number.isFinite(x) ? x.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '∞');

export function explainNode(node: ResolvedNode, m: NodeMetrics): Explanation[] {
  const capped = Math.min(m.rho, RHO_CAP);
  return [
    {
      metric: 'rho',
      formula: 'ρ = λ / (c · μ)',
      substituted: `ρ = ${num(m.lambda)} / (${node.replicas} · ${num(node.capacityRps)})`,
      result: `ρ = ${num(m.rho)}`,
    },
    {
      metric: 'meanLatency',
      formula: 'W = t₀ / (1 − ρ)',
      substituted: `W = ${ms(node.baseLatencyMs)} / (1 − ${num(capped)})`,
      result: `W = ${ms(m.meanLatencyMs)}`,
    },
    {
      metric: 'p95',
      formula: 'T₉₅ = W · ln 20',
      substituted: `T₉₅ = ${ms(m.meanLatencyMs)} · 3,00`,
      result: `T₉₅ = ${ms(m.p95Ms)}`,
    },
    {
      metric: 'p99',
      formula: 'T₉₉ = W · ln 100',
      substituted: `T₉₉ = ${ms(m.meanLatencyMs)} · 4,61`,
      result: `T₉₉ = ${ms(m.p99Ms)}`,
    },
  ];
}
