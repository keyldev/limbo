import { simulate, type LoadStatus, type SimulationResult } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';
import presetsFile from '../../../spec/presets/default.json';
import scenario from '../../../spec/scenarios/url-shortener.loadline.json';

/**
 * Живое демо на первом экране: сценарий «Сокращатель ссылок» из spec/ и настоящий движок.
 * Цепочка линейная, поэтому рисуем её разметкой, без библиотеки доски.
 */

const presets = presetsFile.presets as Preset[];
const base = scenario as unknown as LoadlineDocument;

/** Шкала трафика как на доске: 50 → 20 000 rps на 0 → 1000, логарифмически. */
const RPS_MIN = 50;
const RPS_MAX = 20_000;
const toSlider = (rps: number): number =>
  Math.round((Math.log(rps / RPS_MIN) / Math.log(RPS_MAX / RPS_MIN)) * 1000);
const fromSlider = (s: number): number => {
  const r = RPS_MIN * Math.pow(RPS_MAX / RPS_MIN, s / 1000);
  return r > 1000 ? Math.round(r / 100) * 100 : r > 200 ? Math.round(r / 10) * 10 : Math.round(r);
};

const fmt = (n: number): string =>
  !Number.isFinite(n)
    ? '∞'
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : `${Math.round(n)}`;
const fmtMs = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} с` : `${Math.round(n)} мс`);
const errPct = (r: number): string => `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : 1)}%`;

/** «1 реплику», «3 реплики», «5 реплик». */
function replicasWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} реплику`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} реплики`;
  return `${n} реплик`;
}

/** Период бега точек по связи: 50 rps — около 2 с, 20k rps — около 0,6 с. */
const flowSeconds = (rps: number): number => Math.min(2.4, Math.max(0.5, 3.2 - 0.6 * Math.log10(Math.max(rps, 1))));

/** Узлы цепочки по порядку: id в сценарии и подписи. */
const CHAIN = [
  { id: 'client', name: 'Пользователи', kind: 'клиенты' },
  { id: 'lb', name: 'Балансер', kind: 'load balancer' },
  { id: 'api', name: 'API', kind: 'сервис' },
  { id: 'cache', name: 'Кэш', kind: 'Redis' },
  { id: 'db', name: 'SQL', kind: 'основная база' },
] as const;

interface State {
  rps: number;
  hit: number;
  replicas: number;
}

function documentFor(s: State): LoadlineDocument {
  return {
    ...base,
    traffic: { ...base.traffic, rps: s.rps },
    nodes: base.nodes.map((n) =>
      n.id === 'api'
        ? { ...n, params: { ...n.params, replicas: s.replicas } }
        : n.id === 'cache'
          ? { ...n, params: { ...n.params, hitRatio: s.hit } }
          : n,
    ),
  };
}

function hintFor(r: SimulationResult, s: State): string {
  const { system } = r;
  const neck = system.bottleneckId ? r.nodes[system.bottleneckId] : undefined;
  const name = CHAIN.find((c) => c.id === system.bottleneckId)?.name ?? '';
  if (neck && neck.rho >= 1) {
    return name === 'API'
      ? `API не справляется: ${fmt(neck.lambda)} rps на ${replicasWord(s.replicas)} по ${fmt(neck.capacityRps / s.replicas)} rps. Добавьте реплик.`
      : name === 'SQL'
        ? 'База захлебнулась промахами кэша и записями. Поднимите hit ratio — или подумайте о репликах.'
        : `${name} перегружен: лишние запросы уходят в ошибки.`;
  }
  if (neck && neck.rho >= 0.7) {
    return `${name} загружен на ${Math.round(neck.rho * 100)}%: задержка уже растёт быстрее трафика.`;
  }
  return s.rps < 4000
    ? 'Поднимите трафик до 6k rps и посмотрите, кто сдастся первым.'
    : 'Запас есть. Попробуйте опустить hit ratio кэша.';
}

function mount(root: HTMLElement): void {
  const chain = root.querySelector<HTMLElement>('[data-chain]')!;
  const q = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;

  // Разметка цепочки: узел, связь с потоком, узел…
  const nodeEls = new Map<string, { card: HTMLElement; load: HTMLElement; bar: HTMLElement; sub: HTMLElement }>();
  const edgeEls: { wire: HTMLElement; rps: HTMLElement }[] = [];
  CHAIN.forEach((c, i) => {
    if (i > 0) {
      const wire = document.createElement('div');
      wire.className = 'wire';
      wire.innerHTML = '<span class="wire-rps"></span>';
      chain.append(wire);
      edgeEls.push({ wire, rps: wire.firstElementChild as HTMLElement });
    }
    const card = document.createElement('div');
    card.className = c.id === 'client' ? 'node node-client' : 'node';
    card.innerHTML = `
      <div class="node-kind">${c.kind}</div>
      <div class="node-name">${c.name}<span class="node-sub"></span></div>
      ${c.id === 'client' ? '<div class="node-load"></div>' : '<div class="node-load"></div><div class="bar"><span></span></div>'}`;
    chain.append(card);
    nodeEls.set(c.id, {
      card,
      load: card.querySelector('.node-load')!,
      bar: card.querySelector('.bar span') ?? document.createElement('span'),
      sub: card.querySelector('.node-sub')!,
    });
  });

  const inputs = {
    rps: q<HTMLInputElement>('[data-in="rps"]'),
    hit: q<HTMLInputElement>('[data-in="hit"]'),
  };
  const outs = {
    rps: q<HTMLElement>('[data-out="rps"]'),
    hit: q<HTMLElement>('[data-out="hit"]'),
    replicas: q<HTMLElement>('[data-out="replicas"]'),
  };
  const metric = (k: string): HTMLElement => q<HTMLElement>(`[data-m="${k}"]`);
  const hint = q<HTMLElement>('[data-hint]');

  const apiNode = base.nodes.find((n) => n.id === 'api');
  const cacheNode = base.nodes.find((n) => n.id === 'cache');
  const state: State = {
    rps: base.traffic.rps,
    hit: cacheNode?.params?.hitRatio ?? 0.8,
    replicas: apiNode?.params?.replicas ?? 3,
  };
  inputs.rps.value = String(toSlider(state.rps));
  inputs.hit.value = String(Math.round(state.hit * 100));

  const render = (): void => {
    const r = simulate(documentFor(state), { presets, samples: 8000, seed: 1 });
    outs.rps.textContent = `${fmt(state.rps)} rps`;
    outs.hit.textContent = `${Math.round(state.hit * 100)}%`;
    outs.replicas.textContent = `×${state.replicas}`;

    for (const c of CHAIN) {
      const m = r.nodes[c.id];
      const el = nodeEls.get(c.id);
      if (!m || !el) continue;
      const status: LoadStatus = m.status;
      el.card.dataset['status'] = c.id === 'client' ? 'ok' : status;
      el.load.textContent = c.id === 'client' ? `${fmt(m.lambda)} rps` : `${Math.round(m.rho * 100)}%`;
      el.bar.style.width = `${Math.min(100, m.rho * 100)}%`;
      el.sub.textContent =
        c.id === 'api' ? ` ×${state.replicas}` : c.id === 'cache' ? ` · ${Math.round(state.hit * 100)}%` : '';
    }
    // Точки-запросы бегут тем быстрее, чем больше поток; цвет связи — состояние узла, куда она ведёт.
    base.edges.forEach((e, i) => {
      const el = edgeEls[i];
      if (!el) return;
      const rps = r.edges[e.id]?.rps ?? 0;
      el.rps.textContent = `${fmt(rps)} rps`;
      el.wire.dataset['flow'] = rps > 0 ? '1' : '0';
      el.wire.style.setProperty('--dur', `${flowSeconds(rps).toFixed(2)}s`);
      el.wire.dataset['status'] = r.nodes[e.to.split(':')[0]!]?.status ?? 'ok';
    });

    const { system } = r;
    metric('p99').textContent = fmtMs(system.p99Ms);
    metric('err').textContent = errPct(system.errorRate);
    metric('err').dataset['tone'] = system.errorRate > 0.05 ? 'over' : system.errorRate > 0.001 ? 'hot' : 'ok';
    metric('cost').textContent = `$${Math.round(system.costMonthlyUsd).toLocaleString('en-US')}`;
    const neck = CHAIN.find((c) => c.id === system.bottleneckId);
    const neckM = system.bottleneckId ? r.nodes[system.bottleneckId] : undefined;
    metric('neck').textContent = neck && neckM ? `${neck.name} ${Math.round(neckM.rho * 100)}%` : '—';
    metric('neck').dataset['tone'] = neckM?.status ?? 'ok';
    hint.textContent = hintFor(r, state);
  };

  inputs.rps.addEventListener('input', () => {
    state.rps = fromSlider(Number(inputs.rps.value));
    render();
  });
  inputs.hit.addEventListener('input', () => {
    state.hit = Number(inputs.hit.value) / 100;
    render();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) =>
    b.addEventListener('click', () => {
      state.replicas = Math.min(12, Math.max(1, state.replicas + Number(b.dataset['step'])));
      render();
    }),
  );

  render();
  root.classList.add('ready');
}

const root = document.getElementById('demo');
if (root) mount(root);
