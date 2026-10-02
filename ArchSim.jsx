import React, { useState, useRef, useEffect, useMemo, useLayoutEffect, useCallback } from "react";

/* ────────────────────────────────────────────────────────────
   Loadline — architecture sketchpad with a load simulator.
   Drag parts onto the board, wire them port→port, push traffic.
   ──────────────────────────────────────────────────────────── */

const NODE_W = 188;
const NODE_H = 78;
const GRID = 12;

// mode: how a node passes requests downstream
//   source  – generates traffic, splits it across outputs
//   split   – each request goes to ONE downstream (round-robin)
//   fanout  – each request calls EVERY downstream, in sequence
//   async   – hands work to consumers; the caller doesn't wait
const KINDS = {
  client:  { label: "Clients",        group: "Edge",    mode: "source", lat: 0,   cap: 0,     cost: 0 },
  cdn:     { label: "CDN",            group: "Edge",    mode: "split",  lat: 12,  cap: 20000, cost: 80,  hit: 0.55 },
  lb:      { label: "Load balancer",  group: "Edge",    mode: "split",  lat: 2,   cap: 10000, cost: 25 },
  gateway: { label: "API gateway",    group: "Edge",    mode: "split",  lat: 6,   cap: 5000,  cost: 60 },
  service: { label: "Service",        group: "Compute", mode: "fanout", lat: 35,  cap: 450,   cost: 140 },
  worker:  { label: "Worker",         group: "Compute", mode: "fanout", lat: 120, cap: 350,   cost: 120 },
  fn:      { label: "Function",       group: "Compute", mode: "fanout", lat: 60,  cap: 1000,  cost: 40 },
  cache:   { label: "Cache",          group: "Data",    mode: "split",  lat: 1,   cap: 25000, cost: 90,  hit: 0.8 },
  sql:     { label: "SQL database",   group: "Data",    mode: "fanout", lat: 8,   cap: 180,   cost: 380 },
  nosql:   { label: "Document store", group: "Data",    mode: "fanout", lat: 5,   cap: 2000,  cost: 260 },
  queue:   { label: "Queue",          group: "Data",    mode: "async",  lat: 4,   cap: 8000,  cost: 50 },
  storage: { label: "Object storage", group: "Data",    mode: "fanout", lat: 40,  cap: 3500,  cost: 23 },
  search:  { label: "Search index",   group: "Data",    mode: "fanout", lat: 25,  cap: 600,   cost: 210 },
};
const GROUPS = ["Edge", "Compute", "Data"];
const MODE_TEXT = {
  source: "Sends requests into the system, split evenly across its links.",
  split: "Routes each request to one downstream link (round-robin).",
  fanout: "Calls every downstream link on each request, one after another.",
  async: "Hands each message to every consumer. Callers don't wait for it.",
};
const STATUS_LABEL = { idle: "idle", ok: "ok", hot: "hot", over: "over", down: "down" };

const ICONS = {
  client: <><rect x="2" y="4" width="13" height="10" rx="1.5" /><path d="M6 18h5M8.5 14v4" /><rect x="17" y="8" width="5" height="11" rx="1" /></>,
  cdn: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18" /></>,
  lb: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="12" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v10M11 9l-5 8M13 9l5 8" /></>,
  gateway: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 8l-2 8" /></>,
  service: <><path d="M12 2l8.5 5v10L12 22l-8.5-5V7z" /><circle cx="12" cy="12" r="3" /></>,
  worker: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
  fn: <path d="M6 4h3l9 16M12.2 11.5L6 20" />,
  cache: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M13 6l-5 7h4l-1 5 5-7h-4z" /></>,
  sql: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  nosql: <><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></>,
  queue: <><rect x="2" y="7" width="20" height="10" rx="2" /><path d="M7 7v10M12 7v10M17 7v10" /></>,
  storage: <><path d="M4 6l2 14h12l2-14" /><ellipse cx="12" cy="6" rx="8" ry="2.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></>,
};
function Icon({ kind, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[kind]}
    </svg>
  );
}

/* ── helpers ─────────────────────────────────────────────── */
let seq = 0;
const uid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const snap = (v) => Math.round(v / GRID) * GRID;
const fmt = (n) => {
  if (!isFinite(n)) return "∞";
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 10) return `${Math.round(n)}`;
  return n.toFixed(n > 0 && n < 1 ? 2 : 0);
};
const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const fmtClock = (t) => {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

function makeNode(kind, x, y, extra = {}) {
  const k = KINDS[kind];
  const node = { id: uid(), kind, name: k.label, x, y, replicas: 1, cap: k.cap, lat: k.lat, cost: k.cost, down: false, ...extra };
  if (k.hit !== undefined && node.hit === undefined) node.hit = k.hit;
  return node;
}

// bezier geometry for a wire from a's output port to b's input port
function wirePts(a, b) {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2];
}
const pathOf = (p) => `M${p[0]},${p[1]} C${p[2]},${p[3]} ${p[4]},${p[5]} ${p[6]},${p[7]}`;
function bez(p, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
}

/* ── scenarios ───────────────────────────────────────────── */
function buildGraph(spec) {
  const nodes = spec.nodes.map(([id, kind, name, x, y, extra]) => ({ ...makeNode(kind, x, y, extra), id, name }));
  const edges = spec.edges.map(([from, to]) => ({ id: `${from}>${to}`, from, to }));
  return { nodes, edges };
}
const SCENARIOS = {
  web: {
    label: "Web app", rps: 1500,
    nodes: [
      ["c", "client", "Web & mobile", 0, 204],
      ["cdn", "cdn", "edge-cdn", 216, 204],
      ["lb", "lb", "public-lb", 432, 204],
      ["a", "service", "api-a", 648, 108],
      ["b", "service", "api-b", 648, 300],
      ["rc", "cache", "hot-cache", 864, 108],
      ["db", "sql", "orders-db", 1080, 108],
      ["q", "queue", "events", 864, 300],
      ["w", "worker", "thumbnailer", 1080, 300, { replicas: 2 }],
      ["s3", "storage", "media-bucket", 1296, 300],
    ],
    edges: [["c", "cdn"], ["cdn", "lb"], ["lb", "a"], ["lb", "b"], ["a", "rc"], ["b", "rc"], ["rc", "db"], ["a", "q"], ["b", "q"], ["q", "w"], ["w", "s3"]],
  },
  pipeline: {
    label: "Telemetry pipeline", rps: 3000,
    nodes: [
      ["c", "client", "Sensors", 0, 204],
      ["gw", "gateway", "ingest-gw", 216, 204],
      ["fn", "fn", "validate", 432, 204, { replicas: 4 }],
      ["q", "queue", "telemetry", 648, 204],
      ["agg", "worker", "aggregator", 864, 108, { replicas: 10 }],
      ["ts", "nosql", "timeseries", 1080, 108, { replicas: 2 }],
      ["ix", "worker", "indexer", 864, 300, { replicas: 6 }],
      ["es", "search", "logs-index", 1080, 300, { replicas: 4 }],
    ],
    edges: [["c", "gw"], ["gw", "fn"], ["fn", "q"], ["q", "agg"], ["agg", "ts"], ["q", "ix"], ["ix", "es"]],
  },
  blank: {
    label: "Blank board", rps: 500,
    nodes: [["c", "client", "Users", 0, 204]],
    edges: [],
  },
};

/* ── the simulator ─────────────────────────────────────────
   Steady-state flow model. Forward pass in topological order
   pushes load through the graph; capacity caps what's served.
   Reverse pass folds success rate and latency back upstream.  */
function simulate(nodes, edges, rps) {
  const byId = {}, out = {}, inc = {}, indeg = {}, load = {}, flow = {};
  nodes.forEach((n) => { byId[n.id] = n; out[n.id] = []; inc[n.id] = []; indeg[n.id] = 0; load[n.id] = n.kind === "client" ? rps : 0; });
  edges.forEach((e) => {
    if (byId[e.from] && byId[e.to]) { out[e.from].push(e); inc[e.to].push(e); indeg[e.to]++; }
  });
  const queue = nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    out[id].forEach((e) => { if (--indeg[e.to] === 0) queue.push(e.to); });
  }

  const st = {};
  for (const id of order) {
    const n = byId[id], k = KINDS[n.kind];
    const inL = load[id];
    const capT = n.kind === "client" ? Infinity : n.down ? 0 : n.cap * n.replicas;
    const served = Math.min(inL, capT);
    const u = capT === Infinity ? 0 : capT === 0 ? (inL > 0 ? 9.99 : 0) : inL / capT;
    const ok = inL > 0 ? served / inL : 1;
    const hit = n.hit ?? 0;
    const pass = served * (1 - hit);
    const outs = out[id];
    for (const e of outs) {
      const f = k.mode === "split" || k.mode === "source" ? pass / outs.length : pass;
      flow[e.id] = f;
      load[e.to] += f;
    }
    // queueing slowdown: flat until ~70% busy, then climbs steeply
    const factor = u >= 1 ? 20 : Math.min(20, 1 + (0.5 * Math.pow(u, 4)) / (1 - u));
    const status = n.down ? "down" : inL < 1e-4 && n.kind !== "client" ? "idle" : u >= 1 ? "over" : u >= 0.8 ? "hot" : "ok";
    const asyncOnly = inc[id].length > 0 && inc[id].every((e) => KINDS[byId[e.from].kind].mode === "async");
    st[id] = { load: inL, served, dropped: inL - served, u, ok, status, capT, asyncOnly, latNow: n.kind === "client" ? 0 : n.lat * factor };
  }
  nodes.forEach((n) => {
    if (!st[n.id]) st[n.id] = { load: 0, served: 0, dropped: 0, u: 0, ok: 1, status: "idle", capT: 0, latNow: 0, succ: 1, e2e: 0 };
  });

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i], n = byId[id], k = KINDS[n.kind], s = st[id];
    const kids = out[id].map((e) => st[e.to]);
    let cs = 1, cl = 0;
    if (kids.length && k.mode !== "async") {
      if (k.mode === "fanout") {
        cs = kids.reduce((a, c) => a * c.succ, 1);
        cl = kids.reduce((a, c) => a + c.e2e, 0);
      } else {
        cs = kids.reduce((a, c) => a + c.succ, 0) / kids.length;
        cl = kids.reduce((a, c) => a + c.e2e, 0) / kids.length;
      }
    }
    const hit = n.hit ?? 0;
    s.succ = s.ok * (hit + (1 - hit) * cs);
    s.e2e = s.latNow + (1 - hit) * cl;
  }

  // queues: how fast backlog grows, and how much spare consumer capacity drains it
  const queues = {};
  nodes.filter((n) => KINDS[n.kind].mode === "async").forEach((n) => {
    let excess = 0, spare = 0;
    out[n.id].forEach((e) => {
      const c = st[e.to];
      excess += (flow[e.id] || 0) * (1 - c.ok);
      spare += Math.max(0, c.capT - c.load);
    });
    queues[n.id] = { excess, spare, consumers: out[n.id].length };
  });

  let offered = 0, okRps = 0, latSum = 0, cost = 0, bottleneck = null;
  nodes.forEach((n) => {
    const s = st[n.id];
    if (n.kind === "client") {
      if (!out[n.id].length) return;
      offered += rps; okRps += rps * s.succ; latSum += rps * s.e2e;
      return;
    }
    cost += n.replicas * n.cost;
    if (s.load > 0 && (!bottleneck || s.u > bottleneck.u)) bottleneck = { id: n.id, name: n.name, u: s.u, status: s.status };
  });
  return {
    st, flow, queues, out,
    summary: { offered, okRps, err: offered ? 1 - okRps / offered : 0, lat: offered ? latSum / offered : 0, cost, bottleneck },
  };
}

function wouldCycle(edges, from, to) {
  // adding from→to closes a loop if `from` is reachable from `to`
  const adj = {};
  edges.forEach((e) => { (adj[e.from] ||= []).push(e.to); });
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return true;
    (adj[id] || []).forEach((n) => { if (!seen.has(n)) { seen.add(n); stack.push(n); } });
  }
  return false;
}

/* ── animated request dots ───────────────────────────────── */
function Particles({ lines, playing, reduced }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!playing || reduced) return;
    let raf, last = performance.now();
    const loop = (now) => { setT((x) => x + (now - last) / 1000); last = now; raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, reduced]);
  return (
    <g>
      {lines.flatMap((l) => {
        const dots = [];
        for (let i = 0; i < l.n; i++) {
          const ph = (t * l.speed + i / l.n) % 1;
          const [x, y] = bez(l.pts, ph);
          dots.push(<circle key={`${l.id}:${i}`} cx={x} cy={y} r="3" className={`ll-dot s-${l.status}`} />);
        }
        return dots;
      })}
    </g>
  );
}

/* ── node card ───────────────────────────────────────────── */
function NodeCard({ n, s, selected, backlog, outCount, onDown, onPortDown }) {
  const k = KINDS[n.kind];
  const pct = Math.round(s.u * 100);
  return (
    <div className={`ll-node s-${s.status}${selected ? " sel" : ""}`} style={{ left: n.x, top: n.y }}
      onPointerDown={(e) => onDown(e, n.id)}>
      {n.kind !== "client" && <span className="ll-port in" aria-hidden="true" />}
      <span className="ll-port out" title="Drag to another part to connect" onPointerDown={(e) => onPortDown(e, n.id)} />
      <div className="ll-nhead">
        <span className="ll-ico"><Icon kind={n.kind} /></span>
        <span className="ll-ntext">
          <b>{n.name}</b>
          <i>{k.label}{n.replicas > 1 ? ` ×${n.replicas}` : ""}</i>
        </span>
        <span className={`ll-pill s-${s.status}`}>{STATUS_LABEL[s.status]}</span>
      </div>
      {n.kind === "client" ? (
        <div className="ll-nstats ll-client">
          <span>{fmt(s.load)} rps out</span>
          <span>{outCount ? `${outCount} link${outCount > 1 ? "s" : ""}` : "not connected"}</span>
        </div>
      ) : (
        <>
          <div className="ll-bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
          <div className="ll-nstats">
            <span>{fmt(s.load)} rps</span>
            <span>{n.kind === "queue" && backlog >= 1 ? `backlog ${fmt(backlog)}` : n.down ? "offline" : `${pct}%`}</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ── inspector pieces ────────────────────────────────────── */
function Readout({ label, value, tone }) {
  return (
    <div className="ll-read">
      <span>{label}</span>
      <b className={tone ? `t-${tone}` : ""}>{value}</b>
    </div>
  );
}
function NumField({ id, label, value, min, max, step = 1, unit, onChange }) {
  return (
    <label className="ll-field" htmlFor={id}>
      <span>{label}</span>
      <span className="ll-num">
        <input id={id} type="number" value={value} min={min} max={max} step={step}
          onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) onChange(clamp(v, min, max)); }} />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

/* ── traffic slider is logarithmic: 50 → 20,000 rps ──────── */
const RPS_MIN = 50, RPS_MAX = 20000;
const toSlider = (r) => Math.round((Math.log(r / RPS_MIN) / Math.log(RPS_MAX / RPS_MIN)) * 1000);
const fromSlider = (s) => {
  const r = RPS_MIN * Math.pow(RPS_MAX / RPS_MIN, s / 1000);
  return r > 1000 ? Math.round(r / 100) * 100 : r > 200 ? Math.round(r / 10) * 10 : Math.round(r);
};

/* ════════════════════════════════════════════════════════════ */
export default function ArchSim() {
  const [scenario, setScenario] = useState("web");
  const [graph, setGraph] = useState(() => buildGraph(SCENARIOS.web));
  const [rps, setRps] = useState(SCENARIOS.web.rps);
  const [playing, setPlaying] = useState(true);
  const [clock, setClock] = useState(0);
  const [spikeUntil, setSpikeUntil] = useState(-1);
  const [backlog, setBacklog] = useState({});
  const [sel, setSel] = useState(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 0.8 });
  const [linkDraft, setLinkDraft] = useState(null);
  const [log, setLog] = useState([]);
  const [fitToken, setFitToken] = useState(1);

  const vpRef = useRef(null);
  const drag = useRef(null);
  const viewRef = useRef(view);
  const clockRef = useRef(0);
  const simRef = useRef(null);
  const prevStatus = useRef(null);
  viewRef.current = view;
  clockRef.current = clock;

  const reduced = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
  const spiking = clock < spikeUntil;
  const effRps = rps * (spiking ? 4 : 1);
  const sim = useMemo(() => simulate(graph.nodes, graph.edges, effRps), [graph, effRps]);
  simRef.current = sim;
  const byId = useMemo(() => Object.fromEntries(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const pushLog = useCallback((items) => {
    const t = clockRef.current;
    setLog((L) => [...items.map((it, i) => ({ ...it, t, key: `${t}-${i}-${Math.random()}` })).reverse(), ...L].slice(0, 60));
  }, []);

  /* sim clock + queue backlog integration */
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      setClock((c) => c + dt);
      setBacklog((b) => {
        const qs = simRef.current.queues, next = {};
        for (const qid in qs) {
          const cur = b[qid] || 0;
          const net = qs[qid].excess - (cur > 0 ? qs[qid].spare : 0);
          next[qid] = Math.max(0, cur + net * dt);
        }
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing]);

  /* event log: report status transitions */
  useEffect(() => {
    const prev = prevStatus.current;
    const msgs = [];
    for (const n of graph.nodes) {
      if (n.kind === "client") continue;
      const s = sim.st[n.id];
      const a = prev ? prev[n.id] : "ok";
      const b = s.status;
      if (!a || a === b) continue;
      const pct = Math.round(s.u * 100);
      if (b === "hot") msgs.push({ lvl: "hot", text: `${n.name} running hot at ${pct}%` });
      else if (b === "over") msgs.push({ lvl: "over", text: s.asyncOnly ? `${n.name} can't keep up at ${pct}%; queue backlog growing` : `${n.name} overloaded at ${pct}%, dropping ${fmt(s.dropped)} rps` });
      else if (b === "down") msgs.push({ lvl: "over", text: `${n.name} taken offline` });
      else if (b === "ok" && prev && (a === "hot" || a === "over" || a === "down")) msgs.push({ lvl: "ok", text: `${n.name} back to normal at ${pct}%` });
    }
    prevStatus.current = Object.fromEntries(Object.entries(sim.st).map(([k, v]) => [k, v.status]));
    if (msgs.length) pushLog(msgs);
  }, [sim, graph.nodes, pushLog]);

  /* fit the board to the viewport */
  const fitView = useCallback(() => {
    const el = vpRef.current;
    if (!el || !graph.nodes.length) return;
    const r = el.getBoundingClientRect();
    const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const bw = Math.max(...xs) + NODE_W - minX, bh = Math.max(...ys) + NODE_H - minY;
    const pad = 32;
    const k = clamp(Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh), 0.5, 1.1);
    // centre when it fits; on narrow screens start from the left edge (the traffic source)
    const x = bw * k <= r.width - pad * 2 ? (r.width - bw * k) / 2 - minX * k : pad - minX * k;
    setView({ k, x, y: (r.height - bh * k) / 2 - minY * k });
  }, [graph.nodes]);
  useLayoutEffect(() => { fitView(); }, [fitToken]); // eslint-disable-line react-hooks/exhaustive-deps

  /* wheel zoom around the cursor */
  useEffect(() => {
    const el = vpRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const k = clamp(v.k * Math.exp(-e.deltaY * 0.0015), 0.3, 2);
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f) => {
    const r = vpRef.current.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    setView((v) => {
      const k = clamp(v.k * f, 0.3, 2);
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };

  const toWorld = (cx, cy) => {
    const r = vpRef.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
  };

  /* graph edits */
  const updateNode = (id, patch) => setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));

  const addNode = (kind, x, y) => {
    const count = graph.nodes.filter((n) => n.kind === kind).length;
    const base = KINDS[kind].label.toLowerCase().replace(/\s+/g, "-");
    const node = makeNode(kind, snap(x), snap(y), { name: count ? `${base}-${count + 1}` : base });
    setGraph((g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSel({ type: "node", id: node.id });
    pushLog([{ lvl: "info", text: `Added ${KINDS[kind].label.toLowerCase()} “${node.name}”` }]);
  };

  const connect = (from, to) => {
    const a = byId[from], b = byId[to];
    if (!a || !b || from === to) return;
    if (b.kind === "client") return pushLog([{ lvl: "warn", text: "Clients only send traffic; they can't receive a link." }]);
    if (graph.edges.some((e) => e.from === from && e.to === to)) return;
    if (wouldCycle(graph.edges, from, to)) return pushLog([{ lvl: "warn", text: `Skipped ${a.name} → ${b.name}: that link would form a loop.` }]);
    const edge = { id: `${from}>${to}`, from, to };
    setGraph((g) => ({ ...g, edges: [...g.edges, edge] }));
    pushLog([{ lvl: "info", text: `Connected ${a.name} → ${b.name}` }]);
  };

  const removeSelected = useCallback(() => {
    if (!sel) return;
    if (sel.type === "node") {
      const n = graph.nodes.find((x) => x.id === sel.id);
      setGraph((g) => ({ nodes: g.nodes.filter((x) => x.id !== sel.id), edges: g.edges.filter((e) => e.from !== sel.id && e.to !== sel.id) }));
      if (n) pushLog([{ lvl: "info", text: `Removed ${n.name}` }]);
    } else {
      setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== sel.id) }));
    }
    setSel(null);
  }, [sel, graph.nodes, pushLog]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeSelected]);

  const loadScenario = (key) => {
    const sc = SCENARIOS[key];
    setScenario(key);
    setGraph(buildGraph(sc));
    setRps(sc.rps);
    setBacklog({});
    setSel(null);
    setSpikeUntil(-1);
    prevStatus.current = null;
    setLog([{ lvl: "info", text: `Loaded “${sc.label}”`, t: clockRef.current, key: `load-${Math.random()}` }]);
    setFitToken((t) => t + 1);
  };

  const spike = () => {
    setSpikeUntil(clockRef.current + 8);
    setPlaying(true);
    pushLog([{ lvl: "warn", text: `Traffic spike: ${fmt(rps * 4)} rps for 8 seconds` }]);
  };

  /* pointer handling on the board */
  const capture = (e) => { try { vpRef.current.setPointerCapture(e.pointerId); } catch { /* noop */ } };
  const onNodeDown = (e, id) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const n = byId[id];
    const p = toWorld(e.clientX, e.clientY);
    setSel({ type: "node", id });
    drag.current = { type: "node", id, dx: p.x - n.x, dy: p.y - n.y };
    capture(e);
  };
  const onPortDown = (e, id) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toWorld(e.clientX, e.clientY);
    drag.current = { type: "link", from: id };
    setLinkDraft({ from: id, x: p.x, y: p.y });
    capture(e);
  };
  const onEdgeDown = (e, id) => {
    e.stopPropagation();
    setSel({ type: "edge", id });
  };
  const onVpDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    drag.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y, moved: false };
    capture(e);
  };
  const onVpMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (d.type === "node") {
      const p = toWorld(e.clientX, e.clientY);
      updateNode(d.id, { x: snap(p.x - d.dx), y: snap(p.y - d.dy) });
    } else if (d.type === "link") {
      const p = toWorld(e.clientX, e.clientY);
      setLinkDraft((l) => l && { ...l, x: p.x, y: p.y });
    } else if (d.type === "pan") {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    }
  };
  const onVpUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === "link") {
      const p = toWorld(e.clientX, e.clientY);
      const target = graph.nodes.find((n) => n.id !== d.from && p.x >= n.x - 10 && p.x <= n.x + NODE_W + 10 && p.y >= n.y - 10 && p.y <= n.y + NODE_H + 10);
      if (target) connect(d.from, target.id);
      setLinkDraft(null);
    } else if (d.type === "pan" && !d.moved) {
      setSel(null);
    }
  };
  const onDrop = (e) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData("text/plain");
    if (!KINDS[kind]) return;
    const p = toWorld(e.clientX, e.clientY);
    addNode(kind, p.x - NODE_W / 2, p.y - NODE_H / 2);
  };
  const addAtCenter = (kind) => {
    const r = vpRef.current.getBoundingClientRect();
    const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const j = (graph.nodes.length % 5) * 24;
    addNode(kind, p.x - NODE_W / 2 + j, p.y - NODE_H / 2 + j);
  };

  /* derived drawing data */
  const wires = useMemo(() => graph.edges.map((e) => {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b) return null;
    const pts = wirePts(a, b);
    const f = sim.flow[e.id] || 0;
    const ts = sim.st[e.to]?.status || "idle";
    const len = Math.hypot(pts[6] - pts[0], pts[7] - pts[1]) + 60;
    return { id: e.id, pts, flow: f, status: ts, n: f > 0 ? clamp(Math.round(Math.log10(f + 1) * 2.2), 1, 9) : 0, speed: 150 / len };
  }).filter(Boolean), [graph.edges, byId, sim]);

  const draftPts = linkDraft && byId[linkDraft.from]
    ? (() => { const a = byId[linkDraft.from]; const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2; const dx = Math.max(40, Math.abs(linkDraft.x - x1) / 2); return [x1, y1, x1 + dx, y1, linkDraft.x - dx, linkDraft.y, linkDraft.x, linkDraft.y]; })()
    : null;

  const S = sim.summary;
  const selNode = sel?.type === "node" ? byId[sel.id] : null;
  const selEdge = sel?.type === "edge" ? graph.edges.find((e) => e.id === sel.id) : null;
  const hotList = graph.nodes
    .filter((n) => n.kind !== "client" && (sim.st[n.id].load > 0 || n.down))
    .sort((a, b) => sim.st[b.id].u - sim.st[a.id].u)
    .slice(0, 7);
  const errTone = S.err > 0.05 ? "over" : S.err > 0.001 ? "hot" : "ok";
  const latTone = S.lat > 600 ? "over" : S.lat > 250 ? "hot" : "ok";

  return (
    <div className="ll-app">
      <style>{CSS}</style>

      <header className="ll-top">
        <div className="ll-brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="5" cy="12" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M7.5 12c5 0 5-6 9-6M7.5 12c5 0 5 6 9 6" />
          </svg>
          Loadline
        </div>

        <label className="ll-scn" htmlFor="ll-scenario">
          <span>Scenario</span>
          <select id="ll-scenario" value={scenario} onChange={(e) => loadScenario(e.target.value)}>
            {Object.entries(SCENARIOS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
        </label>

        <div className="ll-simctl">
          <button className="ll-btn primary" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
            {playing ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" fill="currentColor" /><rect x="7" y="1.5" width="3" height="9" fill="currentColor" /></svg>
              : <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5l7 4.5-7 4.5z" fill="currentColor" /></svg>}
            {playing ? "Pause" : "Run"}
          </button>
          <span className="ll-clock">t+{fmtClock(clock)}</span>
          <label className="ll-traffic" htmlFor="ll-traffic">
            <span>Traffic</span>
            <input id="ll-traffic" type="range" min="0" max="1000" value={toSlider(rps)} onChange={(e) => setRps(fromSlider(Number(e.target.value)))} />
            <b>{fmt(effRps)} rps</b>
          </label>
          <button className={`ll-btn${spiking ? " spiking" : ""}`} onClick={spike} disabled={spiking}>
            {spiking ? `Spike ${Math.ceil(spikeUntil - clock)}s` : "Spike ×4"}
          </button>
        </div>

        <dl className="ll-metrics">
          <div><dt>Served</dt><dd>{fmt(S.okRps)} <small>rps</small></dd></div>
          <div><dt>Errors</dt><dd className={`t-${errTone}`}>{(S.err * 100).toFixed(S.err > 0 && S.err < 0.01 ? 2 : 1)}%</dd></div>
          <div><dt>Mean latency</dt><dd className={`t-${latTone}`}>{S.offered ? fmtMs(S.lat) : "–"}</dd></div>
          <div><dt>Cost</dt><dd>{money(S.cost)}<small>/mo</small></dd></div>
          <div><dt>Bottleneck</dt><dd className={S.bottleneck ? `t-${S.bottleneck.status === "idle" ? "ok" : S.bottleneck.status}` : ""}>
            {S.bottleneck ? `${S.bottleneck.name} ${S.bottleneck.status === "down" ? "down" : `${Math.round(S.bottleneck.u * 100)}%`}` : "–"}
          </dd></div>
        </dl>
      </header>

      <main className="ll-main">
        <aside className="ll-palette" aria-label="Parts">
          {GROUPS.map((g) => (
            <section key={g} className="ll-group">
              <h3>{g}</h3>
              {Object.entries(KINDS).filter(([, k]) => k.group === g).map(([kind, k]) => (
                <button key={kind} className="ll-part" draggable
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", kind); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => addAtCenter(kind)} title={`Drag onto the board, or click to add ${k.label.toLowerCase()}`}>
                  <span className="ll-ico"><Icon kind={kind} /></span>
                  <span className="ll-ptext">
                    {k.label}
                    <small>{kind === "client" ? "traffic source" : `${fmt(k.cap)} rps · ${k.lat} ms`}</small>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <section className="ll-center">
          <div ref={vpRef} className={`ll-vp${linkDraft ? " linking" : ""}`}
            style={{ backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
            onPointerDown={onVpDown} onPointerMove={onVpMove} onPointerUp={onVpUp} onPointerCancel={onVpUp}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>

            <div className="ll-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
              <svg className="ll-wires" width="1" height="1">
                {wires.map((w) => {
                  const d = pathOf(w.pts);
                  const sw = w.flow > 0 ? clamp(1.2 + Math.log10(w.flow + 1) * 0.7, 1.4, 4) : 1.2;
                  const isSel = sel?.type === "edge" && sel.id === w.id;
                  return (
                    <g key={w.id} className={`ll-wire s-${w.status}${isSel ? " sel" : ""}${w.flow > 0 ? "" : " dry"}`}>
                      <path d={d} className="ll-hit" onPointerDown={(e) => onEdgeDown(e, w.id)} />
                      <path d={d} className="ll-stroke" strokeWidth={sw} />
                    </g>
                  );
                })}
                <Particles lines={wires.filter((w) => w.n > 0)} playing={playing} reduced={reduced} />
                {view.k > 0.55 && wires.filter((w) => w.flow > 0).map((w) => {
                  const [mx, my] = bez(w.pts, 0.5);
                  const txt = `${fmt(w.flow)} rps`;
                  const tw = txt.length * 6.3 + 10;
                  return (
                    <g key={`lbl-${w.id}`} className="ll-elabel" transform={`translate(${mx - tw / 2}, ${my - 9})`}>
                      <rect width={tw} height="17" rx="4" />
                      <text x={tw / 2} y="12" textAnchor="middle">{txt}</text>
                    </g>
                  );
                })}
                {draftPts && <path d={pathOf(draftPts)} className="ll-draft" />}
              </svg>

              {graph.nodes.map((n) => (
                <NodeCard key={n.id} n={n} s={sim.st[n.id]} selected={sel?.type === "node" && sel.id === n.id}
                  backlog={backlog[n.id] || 0} outCount={sim.out[n.id]?.length || 0}
                  onDown={onNodeDown} onPortDown={onPortDown} />
              ))}
            </div>

            {!graph.nodes.length && (
              <div className="ll-empty">Drag a part here from the list, then wire its right-hand port to the next part.</div>
            )}
            <div className="ll-zoom" onPointerDown={(e) => e.stopPropagation()}>
              <button className="ll-btn icon" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
              <button className="ll-btn icon" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
              <button className="ll-btn icon" onClick={fitView} aria-label="Fit board to view">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" /></svg>
              </button>
              <span className="ll-zpct">{Math.round(view.k * 100)}%</span>
            </div>
            <div className="ll-hint">Drag from <i className="ll-portdot" /> to connect · drag board to pan · scroll to zoom · Delete removes</div>
          </div>

          <ol className="ll-log" aria-label="Event log">
            {log.length === 0 && <li className="lvl-info"><time>{fmtClock(clock)}</time><span>All parts within capacity.</span></li>}
            {log.map((l) => (
              <li key={l.key} className={`lvl-${l.lvl}`}>
                <time>{fmtClock(l.t)}</time>
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <aside className="ll-insp" aria-label="Inspector">
          {selNode ? (
            <NodeInspector n={selNode} s={sim.st[selNode.id]} rps={effRps} backlog={backlog[selNode.id] || 0}
              queue={sim.queues[selNode.id]} update={(p) => updateNode(selNode.id, p)} remove={removeSelected} />
          ) : selEdge ? (
            <div className="ll-ins">
              <p className="ll-eyebrow">Link</p>
              <h2>{byId[selEdge.from]?.name} → {byId[selEdge.to]?.name}</h2>
              <p className="ll-note">{MODE_TEXT[KINDS[byId[selEdge.from].kind].mode]}</p>
              <div className="ll-reads">
                <Readout label="Flow" value={`${fmt(sim.flow[selEdge.id] || 0)} rps`} />
                <Readout label="Destination load" value={`${Math.round(sim.st[selEdge.to].u * 100)}%`} tone={sim.st[selEdge.to].status} />
              </div>
              <button className="ll-btn danger" onClick={removeSelected}>Delete link</button>
            </div>
          ) : (
            <div className="ll-ins">
              <p className="ll-eyebrow">System</p>
              <h2>Load by part</h2>
              <p className="ll-note">Busiest first. Select a part on the board to change replicas, capacity and latency, or to simulate an outage.</p>
              <ul className="ll-hotlist">
                {hotList.map((n) => {
                  const s = sim.st[n.id];
                  return (
                    <li key={n.id}>
                      <button onClick={() => setSel({ type: "node", id: n.id })}>
                        <span className="ll-ico sm"><Icon kind={n.kind} size={14} /></span>
                        <span className="ll-hname">{n.name}</span>
                        <span className={`ll-hval t-${s.status}`}>{n.down ? "down" : `${Math.round(s.u * 100)}%`}</span>
                        <span className={`ll-bar s-${s.status}`}><span style={{ width: `${Math.min(100, s.u * 100)}%` }} /></span>
                      </button>
                    </li>
                  );
                })}
                {!hotList.length && <li className="ll-note">No traffic is reaching any part yet. Connect a client to something.</li>}
              </ul>
              <div className="ll-reads">
                <Readout label="Offered load" value={`${fmt(S.offered)} rps`} />
                <Readout label="Success rate" value={`${(100 - S.err * 100).toFixed(2)}%`} tone={errTone} />
                <Readout label="Monthly cost" value={money(S.cost)} />
              </div>
              <p className="ll-note small">Model: steady-state flow. Each part serves up to replicas × capacity; past ~70% busy, queueing pushes latency up; past 100%, requests are dropped, except behind a queue, where they pile up as backlog.</p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function NodeInspector({ n, s, rps, backlog, queue, update, remove }) {
  const k = KINDS[n.kind];
  const pct = Math.round(s.u * 100);
  return (
    <div className="ll-ins">
      <p className="ll-eyebrow"><Icon kind={n.kind} size={14} /> {k.label}</p>
      <label className="ll-field" htmlFor="insp-name">
        <span>Name</span>
        <input id="insp-name" type="text" value={n.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <p className="ll-note">{MODE_TEXT[k.mode]}</p>

      {n.kind === "client" ? (
        <div className="ll-reads">
          <Readout label="Sending" value={`${fmt(rps)} rps`} />
          <Readout label="Requests succeeding" value={`${(s.succ * 100).toFixed(2)}%`} tone={s.succ < 0.95 ? "over" : s.succ < 0.999 ? "hot" : "ok"} />
          <Readout label="Mean latency seen" value={fmtMs(s.e2e)} />
          <p className="ll-note small">Traffic is set by the slider in the top bar.</p>
        </div>
      ) : (
        <>
          <div className="ll-fieldrow">
            <div className="ll-field">
              <span>Replicas</span>
              <span className="ll-stepper">
                <button className="ll-btn icon" onClick={() => update({ replicas: Math.max(1, n.replicas - 1) })} aria-label="Remove a replica">−</button>
                <b>{n.replicas}</b>
                <button className="ll-btn icon" onClick={() => update({ replicas: Math.min(64, n.replicas + 1) })} aria-label="Add a replica">+</button>
              </span>
            </div>
            <NumField id="insp-cap" label="Capacity / replica" unit="rps" value={n.cap} min={1} max={100000} step={10} onChange={(v) => update({ cap: v })} />
          </div>
          <div className="ll-fieldrow">
            <NumField id="insp-lat" label="Base latency" unit="ms" value={n.lat} min={0} max={5000} onChange={(v) => update({ lat: v })} />
            <NumField id="insp-cost" label="Cost / replica" unit="$/mo" value={n.cost} min={0} max={100000} step={5} onChange={(v) => update({ cost: v })} />
          </div>
          {n.hit !== undefined && (
            <label className="ll-field" htmlFor="insp-hit">
              <span>Hit ratio <b className="ll-inline">{Math.round(n.hit * 100)}%</b></span>
              <input id="insp-hit" type="range" min="0" max="99" value={Math.round(n.hit * 100)} onChange={(e) => update({ hit: Number(e.target.value) / 100 })} />
            </label>
          )}
          <label className="ll-switch" htmlFor="insp-down">
            <input id="insp-down" type="checkbox" checked={n.down} onChange={(e) => update({ down: e.target.checked })} />
            <span className="ll-track" aria-hidden="true"><span /></span>
            Simulate outage
          </label>

          <div className="ll-gauge">
            <div className={`ll-bar big s-${s.status}`}><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
            <div className="ll-gaugetxt"><span className={`t-${s.status}`}>{n.down ? "Offline" : `${pct}% busy`}</span><span>{fmt(s.load)} / {fmt(s.capT)} rps</span></div>
          </div>
          <div className="ll-reads">
            <Readout label="Incoming" value={`${fmt(s.load)} rps`} />
            <Readout label="Served" value={`${fmt(s.served)} rps`} />
            {s.asyncOnly
              ? <Readout label="Falling behind by" value={`${fmt(s.dropped)} msg/s`} tone={s.dropped > 0.5 ? "over" : undefined} />
              : <Readout label="Dropped" value={`${fmt(s.dropped)} rps`} tone={s.dropped > 0.5 ? "over" : undefined} />}
            {n.hit !== undefined && <Readout label="Passed downstream" value={`${fmt(s.served * (1 - n.hit))} rps`} />}
            {queue && <Readout label="Backlog" value={`${fmt(backlog)} msgs`} tone={backlog > 1 ? (queue.excess > 0 ? "over" : "hot") : undefined} />}
            <Readout label="Latency now" value={fmtMs(s.latNow)} tone={s.latNow > n.lat * 3 ? "over" : s.latNow > n.lat * 1.5 ? "hot" : undefined} />
            <Readout label="Monthly cost" value={money(n.cost * n.replicas)} />
          </div>
        </>
      )}
      <button className="ll-btn danger" onClick={remove}>Delete {n.name}</button>
    </div>
  );
}

/* ── styles ──────────────────────────────────────────────── */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

/* Layout: drafting workbench. Parts bin left, dotted board centre, spec sheet right. */
:root{
  --bg:#E8ECEF; --panel:#F8FAFB; --board:#EEF2F4; --dot:#C4CDD4;
  --ink:#15202B; --muted:#5A6773; --line:#D3DAE0; --wire:#95A2AD;
  --accent:#2F4FD6; --accent-ink:#FFFFFF; --accent-soft:#E1E6FA;
  --ok:#1D9660; --hot:#B97705; --over:#CF3636; --idle:#A0ABB5;
  --ok-soft:#DBF0E5; --hot-soft:#FAEDD2; --over-soft:#F8DDDD;
  --shadow:0 1px 2px rgba(21,32,43,.07),0 6px 16px rgba(21,32,43,.06);
  --sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0C1115; --panel:#131A20; --board:#0F161B; --dot:#25313A;
    --ink:#E1E7EC; --muted:#8B98A4; --line:#24303A; --wire:#4E5C68;
    --accent:#8197FF; --accent-ink:#0C1115; --accent-soft:#1D2646;
    --ok:#3CC488; --hot:#EBA83C; --over:#F26A6A; --idle:#56636E;
    --ok-soft:#12302A; --hot-soft:#33270F; --over-soft:#3B1B1D;
    --shadow:0 1px 2px rgba(0,0,0,.45),0 8px 20px rgba(0,0,0,.3);
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#0C1115; --panel:#131A20; --board:#0F161B; --dot:#25313A;
  --ink:#E1E7EC; --muted:#8B98A4; --line:#24303A; --wire:#4E5C68;
  --accent:#8197FF; --accent-ink:#0C1115; --accent-soft:#1D2646;
  --ok:#3CC488; --hot:#EBA83C; --over:#F26A6A; --idle:#56636E;
  --ok-soft:#12302A; --hot-soft:#33270F; --over-soft:#3B1B1D;
  --shadow:0 1px 2px rgba(0,0,0,.45),0 8px 20px rgba(0,0,0,.3);
  color-scheme:dark;
}
html,body,#root{height:100%}
body{background:var(--bg);color:var(--ink)}
.ll-app{height:100%;min-height:560px;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--bg);color:var(--ink);font:13px/1.4 var(--sans);font-variant-numeric:tabular-nums}
.ll-app *{box-sizing:border-box}
.ll-app button,.ll-app input,.ll-app select{font:inherit;color:inherit}
.ll-app :focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* top bar */
.ll-top{display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
.ll-brand{display:flex;align-items:center;gap:8px;font:600 16px/1 var(--mono);letter-spacing:-.01em;color:var(--ink)}
.ll-brand svg{color:var(--accent)}
.ll-scn,.ll-traffic{display:flex;align-items:center;gap:8px}
.ll-scn>span,.ll-traffic>span,.ll-metrics dt,.ll-eyebrow,.ll-field>span,.ll-group h3{font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.ll-scn select{height:30px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
.ll-simctl{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.ll-clock{font:500 12px var(--mono);color:var(--muted);min-width:64px}
.ll-traffic input{width:140px;accent-color:var(--accent)}
.ll-traffic b{font:600 13px var(--mono);min-width:72px}
.ll-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-weight:500;cursor:pointer;white-space:nowrap}
.ll-btn:hover:not(:disabled){border-color:var(--wire)}
.ll-btn:disabled{cursor:default;opacity:.85}
.ll-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.ll-btn.primary:hover{filter:brightness(1.08)}
.ll-btn.spiking{background:var(--over-soft);border-color:var(--over);color:var(--over);font-family:var(--mono)}
.ll-btn.icon{width:30px;padding:0;font-size:16px}
.ll-btn.danger{margin-top:auto;color:var(--over);border-color:var(--over-soft);background:transparent;width:100%}
.ll-btn.danger:hover{background:var(--over-soft);border-color:var(--over)}
.ll-metrics{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0 0 0 auto}
.ll-metrics div{display:flex;flex-direction:column;gap:2px;min-width:0}
.ll-metrics dd{margin:0;font:600 14px var(--mono);white-space:nowrap}
.ll-metrics small{font-weight:400;color:var(--muted);font-size:11px;margin-left:2px}
.t-ok{color:var(--ok)} .t-hot{color:var(--hot)} .t-over,.t-down{color:var(--over)} .t-idle{color:var(--muted)}

/* three panes */
.ll-main{display:grid;grid-template-columns:212px minmax(0,1fr) 292px;min-height:0}
.ll-palette{background:var(--panel);border-right:1px solid var(--line);overflow:auto;padding:14px 10px;display:flex;flex-direction:column;gap:16px}
.ll-group{display:flex;flex-direction:column;gap:2px}
.ll-group h3{margin:0 6px 6px}
.ll-part{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;width:100%;padding:6px;border:1px solid transparent;border-radius:7px;background:none;text-align:left;cursor:grab}
.ll-part:hover{background:var(--board);border-color:var(--line)}
.ll-part:active{cursor:grabbing}
.ll-ptext{display:flex;flex-direction:column;font-weight:500;min-width:0}
.ll-ptext small{font:400 11px var(--mono);color:var(--muted)}
.ll-ico{display:grid;place-items:center;width:32px;height:32px;border-radius:7px;background:var(--board);border:1px solid var(--line);color:var(--ink);flex:none}
.ll-ico.sm{width:24px;height:24px;border-radius:5px}

/* board */
.ll-center{display:grid;grid-template-rows:minmax(0,1fr) auto;min-width:0;min-height:0}
.ll-vp{position:relative;overflow:hidden;background-color:var(--board);background-image:radial-gradient(circle,var(--dot) 1.1px,transparent 1.4px);touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}
.ll-vp:active{cursor:grabbing}
.ll-vp.linking{cursor:crosshair}
.ll-layer{position:absolute;left:0;top:0;transform-origin:0 0}
.ll-wires{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.ll-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.ll-stroke{fill:none;stroke:var(--wire)}
.ll-wire.dry .ll-stroke{stroke-dasharray:4 5}
.ll-wire.s-over .ll-stroke,.ll-wire.s-down .ll-stroke{stroke:var(--over)}
.ll-wire.sel .ll-stroke{stroke:var(--accent)}
.ll-dot{fill:var(--accent)}
.ll-dot.s-hot{fill:var(--hot)}
.ll-dot.s-over,.ll-dot.s-down{fill:var(--over)}
.ll-elabel rect{fill:var(--panel);stroke:var(--line)}
.ll-elabel text{fill:var(--muted);font:500 10.5px var(--mono)}
.ll-draft{fill:none;stroke:var(--accent);stroke-width:2;stroke-dasharray:6 5}

.ll-node{position:absolute;width:${NODE_W}px;height:${NODE_H}px;padding:9px 12px 8px;display:flex;flex-direction:column;gap:7px;background:var(--panel);border:1px solid var(--line);border-radius:9px;box-shadow:var(--shadow);cursor:pointer;transition:border-color .2s,background-color .2s}
.ll-node:hover{border-color:var(--wire)}
.ll-node.sel{outline:2px solid var(--accent);outline-offset:2px}
.ll-node.s-over{border-color:var(--over);background:linear-gradient(var(--over-soft),var(--panel) 60%)}
.ll-node.s-hot{border-color:color-mix(in srgb,var(--hot) 55%,var(--line))}
.ll-node.s-down{background-color:var(--panel);background-image:repeating-linear-gradient(135deg,transparent 0 7px,var(--line) 7px 8px);border-color:var(--over)}
.ll-node.s-idle{opacity:.8}
.ll-nhead{display:flex;align-items:center;gap:8px;min-width:0}
.ll-nhead .ll-ico{width:28px;height:28px;border-radius:6px}
.ll-ntext{display:flex;flex-direction:column;min-width:0;flex:1}
.ll-ntext b{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ll-ntext i{font-style:normal;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ll-pill{flex:none;font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.06em;padding:2px 5px;border-radius:4px;background:var(--board);color:var(--muted)}
.ll-pill.s-ok{background:var(--ok-soft);color:var(--ok)}
.ll-pill.s-hot{background:var(--hot-soft);color:var(--hot)}
.ll-pill.s-over,.ll-pill.s-down{background:var(--over);color:var(--panel)}
.ll-bar{display:block;height:4px;border-radius:2px;background:var(--line);overflow:hidden}
.ll-bar>span{display:block;height:100%;border-radius:2px;background:var(--ok);transition:width .25s ease,background-color .25s}
.ll-node.s-hot .ll-bar>span,.ll-bar.s-hot>span{background:var(--hot)}
.ll-node.s-over .ll-bar>span,.ll-bar.s-over>span{background:var(--over)}
.ll-bar.s-idle>span{background:var(--idle)}
.ll-nstats{display:flex;justify-content:space-between;font:500 11px var(--mono);color:var(--muted)}
.ll-nstats.ll-client{margin-top:auto}
.ll-port{position:absolute;top:50%;width:14px;height:14px;margin-top:-7px;border-radius:50%;background:var(--panel);border:2px solid var(--wire)}
.ll-port.in{left:-8px;pointer-events:none}
.ll-port.out{right:-8px;cursor:crosshair}
.ll-port.out::after{content:"";position:absolute;inset:-8px;border-radius:50%}
.ll-port.out:hover,.ll-vp.linking .ll-port.in{border-color:var(--accent);background:var(--accent-soft)}

.ll-empty{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:var(--muted);pointer-events:none}
.ll-zoom{position:absolute;top:12px;right:12px;display:flex;align-items:center;gap:4px;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)}
.ll-zoom .ll-btn{border-color:transparent;height:28px;width:28px}
.ll-zpct{font:500 11px var(--mono);color:var(--muted);min-width:38px;text-align:center}
.ll-hint{position:absolute;left:12px;bottom:10px;max-width:calc(100% - 24px);padding:4px 8px;border-radius:6px;background:color-mix(in srgb,var(--panel) 88%,transparent);font:400 11px var(--mono);color:var(--muted);pointer-events:none}
.ll-portdot{display:inline-block;width:9px;height:9px;border-radius:50%;border:2px solid var(--wire);vertical-align:-1px}

.ll-log{list-style:none;margin:0;padding:8px 16px;height:118px;overflow:auto;border-top:1px solid var(--line);background:var(--panel);font:12px/1.65 var(--mono)}
.ll-log li{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px}
.ll-log time{color:var(--muted)}
.ll-log li span{overflow-wrap:anywhere}
.ll-log .lvl-hot span,.ll-log .lvl-warn span{color:var(--hot)}
.ll-log .lvl-over span{color:var(--over)}
.ll-log .lvl-ok span{color:var(--ok)}

/* inspector */
.ll-insp{background:var(--panel);border-left:1px solid var(--line);overflow:auto;min-width:0}
.ll-ins{display:flex;flex-direction:column;gap:14px;padding:16px;min-height:100%}
.ll-ins h2{margin:-8px 0 0;font-size:17px;font-weight:600;letter-spacing:-.01em;text-wrap:balance;overflow-wrap:anywhere}
.ll-eyebrow{display:flex;align-items:center;gap:6px;margin:0}
.ll-note{margin:0;color:var(--muted);font-size:12.5px;line-height:1.5}
.ll-note.small{font-size:11.5px}
.ll-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.ll-field input[type=text],.ll-num input{height:32px;width:100%;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);font-family:var(--mono);font-size:12.5px;min-width:0}
.ll-field input[type=range]{accent-color:var(--accent)}
.ll-inline{font-family:var(--mono);color:var(--ink);letter-spacing:0;text-transform:none;margin-left:4px}
.ll-num{position:relative;display:flex}
.ll-num em{position:absolute;right:8px;top:50%;transform:translateY(-50%);font:400 11px var(--mono);font-style:normal;color:var(--muted);pointer-events:none}
.ll-num input{padding-right:38px}
.ll-fieldrow{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ll-stepper{display:flex;align-items:center;gap:4px;height:32px}
.ll-stepper b{flex:1;text-align:center;font:600 14px var(--mono)}
.ll-stepper .ll-btn{height:32px;width:32px}
.ll-switch{display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:500}
.ll-switch input{position:absolute;opacity:0;width:1px;height:1px}
.ll-track{width:34px;height:20px;border-radius:10px;background:var(--line);position:relative;transition:background .2s;flex:none}
.ll-track span{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--panel);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .2s}
.ll-switch input:checked+.ll-track{background:var(--over)}
.ll-switch input:checked+.ll-track span{transform:translateX(14px)}
.ll-switch input:focus-visible+.ll-track{outline:2px solid var(--accent);outline-offset:2px}
.ll-gauge{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;background:var(--board);border:1px solid var(--line)}
.ll-bar.big{height:8px;border-radius:4px}
.ll-gaugetxt{display:flex;justify-content:space-between;gap:8px;font:600 12.5px var(--mono)}
.ll-gaugetxt span:last-child{color:var(--muted);font-weight:400}
.ll-reads{display:flex;flex-direction:column}
.ll-read{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:12.5px}
.ll-read span{color:var(--muted)}
.ll-read b{font:600 12.5px var(--mono);text-align:right}
.ll-hotlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ll-hotlist button{display:grid;grid-template-columns:24px minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:10px;row-gap:5px;align-items:center;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:7px;background:none;cursor:pointer;text-align:left}
.ll-hotlist button:hover{background:var(--board);border-color:var(--line)}
.ll-hotlist .ll-ico{grid-row:1/3}
.ll-hname{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ll-hval{font:600 12px var(--mono)}
.ll-hotlist .ll-bar{grid-column:2/4}

@media (max-width: 960px){
  .ll-main{grid-template-columns:184px minmax(0,1fr)}
  .ll-insp{grid-column:1/-1;border-left:0;border-top:1px solid var(--line)}
  .ll-app{height:auto}
  .ll-center{height:68vh;min-height:420px}
}
@media (max-width: 640px){
  .ll-main{grid-template-columns:minmax(0,1fr)}
  .ll-palette{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:8px 12px;gap:4px;border-right:0;border-bottom:1px solid var(--line)}
  .ll-group{flex-direction:row;gap:4px;flex:none}
  .ll-group h3{display:none}
  .ll-part{width:auto;flex:none;grid-template-columns:32px auto;padding:4px 8px 4px 4px}
  .ll-part small{display:none}
  .ll-metrics{margin-left:0;width:100%;gap:6px 16px}
  .ll-traffic input{width:110px}
  .ll-hint{display:none}
  .ll-fieldrow{grid-template-columns:1fr}
}
@media (prefers-reduced-motion: reduce){
  .ll-app *{transition:none!important}
}
`;
