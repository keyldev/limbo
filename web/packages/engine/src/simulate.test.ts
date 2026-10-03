import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LoadlineDocument, Preset } from '@loadline/model';
import { migrate } from './migrate.js';
import { DEFAULT_SAMPLES, MIN_SAMPLES, simulate } from './simulate.js';

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

describe('маршрутизация потока', () => {
  const opts = { presets, samples: 4000, seed: 5 };
  const doc = (nodes: LoadlineDocument['nodes'], edges: [string, string][], rps = 1000): LoadlineDocument => ({
    format: 'loadline',
    version: 1,
    traffic: { rps, readShare: 1 },
    nodes,
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, from: `${from}:out`, to: `${to}:in` })),
  });
  const at = (id: string, kind: LoadlineDocument['nodes'][number]['kind'], replicas = 1) => ({
    id,
    kind,
    pos: { x: 0, y: 0 },
    params: { replicas },
  });

  it('балансировщик делит поток поровну между сервисами', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 1, max: 6 }), (rps, backends) => {
        const ids = Array.from({ length: backends }, (_, i) => `s${i}`);
        const r = simulate(
          doc(
            [at('c', 'client'), at('lb', 'load-balancer', 4), ...ids.map((id) => at(id, 'service', 50))],
            [['c', 'lb'], ...ids.map((id): [string, string] => ['lb', id])],
            rps,
          ),
          opts,
        );
        return ids.every((id) => Math.abs(r.nodes[id]!.lambda - rps / backends) < 1e-6);
      }),
      { numRuns: 40 },
    );
  });

  it('клиент с двумя связями делит трафик, сервис зовёт все зависимости', () => {
    const r = simulate(
      doc(
        [at('c', 'client'), at('a', 'service', 10), at('b', 'service', 10), at('x', 'nosql'), at('y', 'search')],
        [['c', 'a'], ['c', 'b'], ['a', 'x'], ['a', 'y']],
      ),
      opts,
    );
    expect(r.nodes['a']!.lambda).toBeCloseTo(500);
    expect(r.nodes['b']!.lambda).toBeCloseTo(500);
    expect(r.nodes['x']!.lambda).toBeCloseTo(500);
    expect(r.nodes['y']!.lambda).toBeCloseTo(500);
    expect(r.edges['e0']!.rps).toBeCloseTo(500);
  });

  it('медленный потребитель за очередью копит backlog, но не даёт ошибок клиенту', () => {
    const r = simulate(
      doc([at('c', 'client'), at('q', 'queue'), at('w', 'worker', 1)], [['c', 'q'], ['q', 'w']], 500),
      opts,
    );
    const worker = r.nodes['w']!;
    expect(worker.status).toBe('over');
    expect(worker.behindQueue).toBe(true);
    expect(r.nodes['q']!.backlogRps).toBeCloseTo(500 - 300);
    expect(r.system.errorRate).toBe(0);
  });

  it('чтения и записи идут по своим связям', () => {
    const d = doc(
      [at('c', 'client'), at('lb', 'load-balancer'), at('r', 'service', 2), at('w', 'service'), at('db', 'nosql')],
      [['c', 'lb'], ['lb', 'r'], ['lb', 'w'], ['r', 'db'], ['w', 'db']],
    );
    d.traffic.readShare = 0.8;
    d.edges[1]!.only = 'read';
    d.edges[2]!.only = 'write';
    const r = simulate(d, opts);
    // Балансировщик не делит поток пополам: все чтения уходят в r, все записи в w.
    expect(r.nodes['r']!.readRps).toBeCloseTo(800);
    expect(r.nodes['r']!.writeRps).toBe(0);
    expect(r.nodes['w']!.writeRps).toBeCloseTo(200);
    expect(r.nodes['w']!.readRps).toBe(0);
    expect(r.edges['e1']!.rps).toBeCloseTo(800);
    expect(r.nodes['db']!.lambda).toBeCloseTo(1000);
  });

  it('запрос, для которого нет связи, заканчивается на узле', () => {
    const d = doc([at('c', 'client'), at('a', 'service'), at('q', 'queue')], [['c', 'a'], ['a', 'q']]);
    d.traffic.readShare = 0.5;
    d.edges[1]!.only = 'write';
    const r = simulate(d, opts);
    expect(r.nodes['q']!.lambda).toBeCloseTo(500);
    expect(r.nodes['q']!.readRps).toBe(0);
    expect(r.system.errorRate).toBe(0);
  });

  it('узел без трафика — idle и не узкое место', () => {
    const r = simulate(doc([at('c', 'client'), at('a', 'service'), at('lonely', 'nosql')], [['c', 'a']]), opts);
    expect(r.nodes['lonely']!.status).toBe('idle');
    expect(r.system.bottleneckId).toBe('a');
  });
});

describe('число сэмплов', () => {
  /** client → сервис → layers слоёв по width сервисов, каждый зовёт весь следующий слой: путей 3^layers. */
  const lattice = (layers: number, width: number): LoadlineDocument => {
    const nodes: LoadlineDocument['nodes'] = [{ id: 'c', kind: 'client', pos: { x: 0, y: 0 } }];
    const edges: LoadlineDocument['edges'] = [];
    let prev = ['c'];
    for (let l = 0; l < layers; l++) {
      const layer = Array.from({ length: l === 0 ? 1 : width }, (_, i) => `s${l}-${i}`);
      for (const id of layer) nodes.push({ id, kind: 'service', pos: { x: 0, y: 0 }, params: { replicas: 500 } });
      for (const a of prev) for (const b of layer) edges.push({ id: `${a}-${b}`, from: `${a}:out`, to: `${b}:in` });
      prev = layer;
    }
    return { format: 'loadline', version: 1, traffic: { rps: 100, readShare: 1 }, nodes, edges };
  };

  it('короткие пути считаются полными 20 000 сэмплов', () => {
    expect(simulate(chain(100, 2, 0.5), { presets }).system.samples).toBe(DEFAULT_SAMPLES);
  });

  it('длинные пути — меньше сэмплов, перцентили в пределах 2% от полного прогона', () => {
    const doc = lattice(6, 3); // 365 узлов на сэмпл
    const fast = simulate(doc, { presets }).system;
    const full = simulate(doc, { presets, samples: DEFAULT_SAMPLES }).system;
    expect(fast.samples).toBeLessThan(DEFAULT_SAMPLES);
    expect(fast.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
    for (const key of ['meanLatencyMs', 'p50Ms', 'p95Ms', 'p99Ms'] as const) {
      expect(Math.abs(fast[key] / full[key] - 1)).toBeLessThan(0.02);
    }
  });

  it('явное число сэмплов не меняется', () => {
    expect(simulate(lattice(6, 3), { presets, samples: 123 }).system.samples).toBe(123);
  });
});

describe('миграции формата', () => {
  it('отклоняет чужие и будущие файлы', () => {
    expect(() => migrate({ format: 'drawio' })).toThrow();
    expect(() => migrate({ format: 'loadline', version: 99 })).toThrow(/новее/);
  });
});
