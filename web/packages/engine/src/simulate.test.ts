import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LoadlineDocument, Preset } from '@loadline/model';
import { migrate } from './migrate.js';
import { simulate } from './simulate.js';

const SPEC = resolve(__dirname, '../../../../spec');
const presets = (JSON.parse(readFileSync(join(SPEC, 'presets/default.json'), 'utf8')) as { presets: Preset[] })
  .presets;

/** Допуск для golden-сверки: ±2%. */
const TOLERANCE = 0.02;

const scenarioFiles = readdirSync(join(SPEC, 'scenarios')).filter((f) => f.endsWith('.loadline.json'));

describe('эталонные сценарии (golden)', () => {
  it.each(scenarioFiles)('%s', (file) => {
    const doc = migrate(JSON.parse(readFileSync(join(SPEC, 'scenarios', file), 'utf8')));
    const { system } = simulate(doc, { presets, seed: 1 });
    const expectedPath = join(SPEC, 'scenarios', file.replace('.loadline.json', '.expected.json'));

    const actual = {
      errorRate: system.errorRate,
      meanLatencyMs: system.meanLatencyMs,
      p95Ms: system.p95Ms,
      p99Ms: system.p99Ms,
      costMonthlyUsd: system.costMonthlyUsd,
      bottleneckId: system.bottleneckId,
    };

    if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(expectedPath)) {
      writeFileSync(expectedPath, JSON.stringify(actual, null, 2) + '\n');
      return;
    }

    const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as typeof actual;
    expect(actual.bottleneckId).toBe(expected.bottleneckId);
    for (const key of ['meanLatencyMs', 'p95Ms', 'p99Ms', 'costMonthlyUsd'] as const) {
      const e = expected[key];
      expect(Math.abs(actual[key] - e)).toBeLessThanOrEqual(Math.abs(e) * TOLERANCE + 1e-9);
    }
    expect(Math.abs(actual.errorRate - expected.errorRate)).toBeLessThanOrEqual(0.005);
  });
});

/** Цепочка client → lb → service → db с параметрами из генератора. */
function chain(rps: number, serviceReplicas: number, hitRatio: number | null): LoadlineDocument {
  const nodes: LoadlineDocument['nodes'] = [
    { id: 'client', kind: 'client', pos: { x: 0, y: 0 } },
    { id: 'lb', kind: 'load-balancer', pos: { x: 1, y: 0 } },
    { id: 'svc', kind: 'service', pos: { x: 2, y: 0 }, params: { replicas: serviceReplicas } },
    { id: 'db', kind: 'sql-primary', pos: { x: 4, y: 0 } },
  ];
  const edges: LoadlineDocument['edges'] = [
    { id: 'e1', from: 'client:out', to: 'lb:in' },
    { id: 'e2', from: 'lb:out', to: 'svc:in' },
  ];
  if (hitRatio === null) {
    edges.push({ id: 'e3', from: 'svc:out', to: 'db:in' });
  } else {
    nodes.push({ id: 'cache', kind: 'cache', pos: { x: 3, y: 0 }, params: { hitRatio } });
    edges.push({ id: 'e3', from: 'svc:out', to: 'cache:in' }, { id: 'e4', from: 'cache:out', to: 'db:in' });
  }
  return { format: 'loadline', version: 1, traffic: { rps, readShare: 1 }, nodes, edges };
}

describe('свойства модели', () => {
  const opts = { presets, samples: 4000, seed: 3 };

  it('при ρ < 1 на всех узлах ошибок нет', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 5 }), (rps, replicas) => {
        const r = simulate(chain(rps, replicas, null), opts);
        const allUnder = Object.values(r.nodes).every((m) => m.rho < 1);
        return !allUnder || r.system.errorRate === 0;
      }),
      { numRuns: 50 },
    );
  });

  it('лишняя реплика не повышает загрузку и среднюю задержку сервиса', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 5000 }), fc.integer({ min: 1, max: 8 }), (rps, replicas) => {
        const a = simulate(chain(rps, replicas, null), opts).nodes['svc']!;
        const b = simulate(chain(rps, replicas + 1, null), opts).nodes['svc']!;
        return b.rho <= a.rho && b.meanLatencyMs <= a.meanLatencyMs;
      }),
      { numRuns: 50 },
    );
  });

  it('кэш с hit ratio 0 не уменьшает поток в базу', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), (rps) => {
        const without = simulate(chain(rps, 4, null), opts).nodes['db']!;
        const withCache = simulate(chain(rps, 4, 0), opts).nodes['db']!;
        return Math.abs(without.lambda - withCache.lambda) < 1e-9;
      }),
      { numRuns: 30 },
    );
  });

  it('отказ узла даёт 100% ошибок на пути через него', () => {
    const doc = chain(100, 2, null);
    doc.nodes.find((n) => n.id === 'db')!.params = { outage: true };
    expect(simulate(doc, opts).system.errorRate).toBe(1);
  });

  it('перегруз уходит в ошибки', () => {
    const r = simulate(chain(10_000, 1, null), opts);
    expect(r.nodes['svc']!.droppedRps).toBeGreaterThan(0);
    expect(r.system.errorRate).toBeGreaterThan(0.5);
    expect(r.system.bottleneckId).toBe('svc');
  });
});

describe('миграции формата', () => {
  it('отклоняет чужие и будущие файлы', () => {
    expect(() => migrate({ format: 'drawio' })).toThrow();
    expect(() => migrate({ format: 'loadline', version: 99 })).toThrow(/новее/);
  });
});
