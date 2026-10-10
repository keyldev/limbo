import type { NodeKind } from '@loadline/model';
import { classify, imageName } from './classify.js';
import { parseCaddyfile, parseNginx, type ProxyConfig } from './proxy.js';
import type { Workload } from './workload.js';
import { YamlError, parseYamlAll } from './yaml.js';

/** Прокси, найденный в манифестах: Ingress, HTTPRoute или nginx.conf в ConfigMap. */
export interface KubeProxy {
  source: string;
  config: ProxyConfig;
  /** Кто проксирует: контроллер Ingress или ворклоад, который монтирует конфиг. */
  owner?: string;
  /** Почему owner — балансировщик, если его нет среди ворклоадов. */
  ownerWhy?: string;
}

export interface KubeManifests {
  name?: string;
  workloads: Workload[];
  proxies: KubeProxy[];
  notes: string[];
}

export class KubernetesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubernetesError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).map(([k, val]) => [k, str(val)]));

/** Ворклоады с шаблоном пода. Rollout — Argo Rollouts, DeploymentConfig — OpenShift. */
const POD_OWNERS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Rollout',
  'DeploymentConfig',
]);

/** Контейнеры-спутники: сетка, логи, секреты. Не основной контейнер пода. */
const SIDECARS = new Set(
  `istio-proxy linkerd-proxy envoy envoy-sidecar cloud-sql-proxy cloudsql-proxy alloydb-auth-proxy
   vault-agent fluent-bit fluentbit fluentd promtail otel-collector opentelemetry-collector
   datadog-agent dd-agent`.split(/\s+/),
);

/**
 * Базы и очереди, которые разворачивают операторы. Оператор сам создаёт сервисы с известными
 * именами — по ним ворклоады и находят базу.
 */
const OPERATORS: readonly {
  group: RegExp;
  kind: string;
  role: NodeKind;
  title: string;
  hosts: (name: string) => string[];
  replicas: (spec: Obj) => number;
  /** Реплики для чтения отдельным узлом: свои адреса и сколько их. */
  readers?: { suffix: string; hosts: (name: string) => string[]; count: (spec: Obj) => number };
}[] = [
  {
    group: /^postgresql\.cnpg\.io\//,
    kind: 'Cluster',
    role: 'sql-primary',
    title: 'CloudNativePG',
    hosts: (n) => [`${n}-rw`],
    replicas: () => 1,
    readers: {
      suffix: '-ro',
      hosts: (n) => [`${n}-ro`, `${n}-r`],
      count: (s) => Number(s['instances'] ?? 1) - 1,
    },
  },
  {
    group: /^acid\.zalan\.do\//,
    kind: 'postgresql',
    role: 'sql-primary',
    title: 'Zalando Postgres Operator',
    hosts: (n) => [n],
    replicas: () => 1,
    readers: {
      suffix: '-repl',
      hosts: (n) => [`${n}-repl`],
      count: (s) => Number(s['numberOfInstances'] ?? 1) - 1,
    },
  },
  {
    group: /^kafka\.strimzi\.io\//,
    kind: 'Kafka',
    role: 'queue',
    title: 'Strimzi',
    hosts: (n) => [`${n}-kafka-bootstrap`, `${n}-kafka-brokers`],
    replicas: (s) => Number(obj(s['kafka'])['replicas'] ?? 1),
  },
  {
    group: /^rabbitmq\.com\//,
    kind: 'RabbitmqCluster',
    role: 'queue',
    title: 'RabbitMQ Cluster Operator',
    hosts: (n) => [n],
    replicas: (s) => Number(s['replicas'] ?? 1),
  },
  {
    group: /^mongodbcommunity\.mongodb\.com\//,
    kind: 'MongoDBCommunity',
    role: 'nosql',
    title: 'MongoDB Community Operator',
    hosts: (n) => [`${n}-svc`],
    replicas: (s) => Number(s['members'] ?? 1),
  },
  {
    group: /^elasticsearch\.k8s\.elastic\.co\//,
    kind: 'Elasticsearch',
    role: 'search',
    title: 'ECK',
    hosts: (n) => [`${n}-es-http`],
    replicas: (s) =>
      list(s['nodeSets']).reduce<number>((sum, ns) => sum + Number(obj(ns)['count'] ?? 1), 0),
  },
];

/** Триггеры KEDA, которые означают «ворклоад разбирает очередь». */
const QUEUE_TRIGGERS =
  /^(rabbitmq|kafka|redis-streams|redis-lists|nats-jetstream|stan|aws-sqs-queue|azure-servicebus|azure-queue|gcp-pubsub|activemq|artemis-queue|pulsar)$/;

interface Meta {
  kind: string;
  apiVersion: string;
  name: string;
  ns: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

function metaOf(o: Obj): Meta {
  const m = obj(o['metadata']);
  return {
    kind: str(o['kind']),
    apiVersion: str(o['apiVersion']),
    name: str(m['name']),
    ns: str(m['namespace']) || 'default',
    labels: strMap(m['labels']),
    annotations: strMap(m['annotations']),
  };
}

/** Все адреса сервиса внутри кластера: api, api.shop, api.shop.svc, api.shop.svc.cluster.local. */
function dnsNames(name: string, ns: string): string[] {
  return [name, `${name}.${ns}`, `${name}.${ns}.svc`, `${name}.${ns}.svc.cluster.local`];
}

/** Шаблон пода ворклоада: метки и spec. У Pod это он сам, у CronJob — через jobTemplate. */
function podTemplate(o: Obj, kind: string): { labels: Record<string, string>; spec: Obj } {
  const spec = obj(o['spec']);
  if (kind === 'Pod') return { labels: metaOf(o).labels, spec };
  const tpl =
    kind === 'CronJob'
      ? obj(obj(obj(spec['jobTemplate'])['spec'])['template'])
      : obj(spec['template']);
  const labels = strMap(obj(tpl['metadata'])['labels']);
  // OpenShift DeploymentConfig и старые манифесты: selector без matchLabels.
  if (!Object.keys(labels).length) {
    const sel = obj(spec['selector']);
    return {
      labels: strMap(isObj(sel['matchLabels']) ? sel['matchLabels'] : sel),
      spec: obj(tpl['spec']),
    };
  }
  return { labels, spec: obj(tpl['spec']) };
}

function isSidecar(c: Obj): boolean {
  const name = str(c['name']).toLowerCase();
  const image = imageName(str(c['image']));
  const base = image.slice(image.lastIndexOf('/') + 1);
  if (SIDECARS.has(name) || SIDECARS.has(base)) return true;
  const role = classify({ name, image, command: '', env: {} }).role;
  return 'skip' in role && role.skip !== 'job';
}

const matches = (selector: Record<string, string>, labels: Record<string, string>): boolean => {
  const keys = Object.keys(selector);
  return keys.length > 0 && keys.every((k) => labels[k] === selector[k]);
};

/** Значения Secret: data в base64, stringData как есть. Бинарное не нужно — только текст. */
function secretData(o: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(o['data']))) {
    try {
      const bytes = Uint8Array.from(atob(str(v).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      out[k] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // не base64 или не текст — пропускаем
    }
  }
  return { ...out, ...strMap(o['stringData']) };
}

/**
 * Читает манифесты Kubernetes: kubectl get -o yaml, вывод helm template, папку с yaml.
 * Ворклоады становятся узлами, Service — их адресами, Ingress и HTTPRoute — прокси на входе,
 * ConfigMap и Secret — переменными, в которых ищутся адреса соседей.
 */
export function parseKubernetes(texts: readonly string[]): KubeManifests {
  const objects: Obj[] = [];
  for (const text of texts) {
    let docs: unknown[];
    try {
      docs = parseYamlAll(text);
    } catch (e) {
      if (e instanceof YamlError) throw new KubernetesError(`YAML не разобрался: ${e.message}`);
      throw e;
    }
    for (const d of docs) {
      if (!isObj(d)) continue;
      // kubectl get … -o yaml отдаёт kind: List с объектами в items.
      if (str(d['kind']).endsWith('List') && Array.isArray(d['items']))
        objects.push(...d['items'].filter(isObj));
      else objects.push(d);
    }
  }
  const metas = objects.map(metaOf);
  if (!metas.some((m) => m.kind && m.apiVersion))
    throw new KubernetesError('Не нашлось объектов Kubernetes: нет apiVersion и kind');

  const notes: string[] = [];
  const byKind = (kind: string): [Obj, Meta][] =>
    objects.map((o, i) => [o, metas[i]!] as [Obj, Meta]).filter(([, m]) => m.kind === kind);
  const key = (ns: string, name: string): string => `${ns}/${name}`;

  const configMaps = new Map(
    byKind('ConfigMap').map(([o, m]) => [key(m.ns, m.name), strMap(o['data'])]),
  );
  const secrets = new Map(byKind('Secret').map(([o, m]) => [key(m.ns, m.name), secretData(o)]));
  const services = byKind('Service');

  // HPA: сколько реплик, если в самом ворклоаде их нет, и до скольких он вырастет.
  const hpa = new Map<string, { min: number; max: number; by: string }>();
  for (const [o, m] of byKind('HorizontalPodAutoscaler')) {
    const spec = obj(o['spec']);
    const target = str(obj(spec['scaleTargetRef'])['name']);
    if (target)
      hpa.set(key(m.ns, target), {
        min: Number(spec['minReplicas'] ?? 1),
        max: Number(spec['maxReplicas'] ?? 1),
        by: 'HPA',
      });
  }
  // KEDA: триггер по очереди — ворклоад разбирает её, адрес очереди лежит в metadata триггера.
  const keda = new Map<string, string[]>();
  for (const [o, m] of byKind('ScaledObject')) {
    const spec = obj(o['spec']);
    const target = str(obj(spec['scaleTargetRef'])['name']);
    const queues = list(spec['triggers'])
      .map(obj)
      .filter((t) => QUEUE_TRIGGERS.test(str(t['type'])));
    if (!target) continue;
    if (queues.length)
      keda.set(
        key(m.ns, target),
        queues.flatMap((t) => Object.values(strMap(t['metadata']))),
      );
    // KEDA сама заводит HPA. Масштаб до нуля на схеме — одна реплика: иначе узла не будет.
    hpa.set(key(m.ns, target), {
      min: Math.max(1, Number(spec['minReplicaCount'] ?? 0)),
      max: Number(spec['maxReplicaCount'] ?? 100),
      by: 'KEDA',
    });
  }

  const workloads: Workload[] = [];
  const names = new Set<string>();
  const uniqueName = (name: string, ns: string): string => {
    const n = names.has(name) ? `${name}.${ns}` : name;
    names.add(n);
    return n;
  };
  /** Ворклоады с метками пода: по ним Service находит, куда слать трафик. */
  const pods: { w: Workload; ns: string; labels: Record<string, string> }[] = [];
  /** Какие ConfigMap монтирует ворклоад: в них может лежать nginx.conf. */
  const mountedBy = new Map<string, string[]>();

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    const m = metas[i]!;
    const isJob = m.kind === 'Job' || m.kind === 'CronJob';
    if (!POD_OWNERS.has(m.kind) && !isJob && m.kind !== 'Pod') continue;
    // Pod, у которого есть владелец, — копия ворклоада из kubectl get all.
    if (m.kind === 'Pod' && list(obj(o['metadata'])['ownerReferences']).length) continue;
    if (m.kind === 'ReplicaSet' && list(obj(o['metadata'])['ownerReferences']).length) continue;
    if (m.kind === 'Job' && list(obj(o['metadata'])['ownerReferences']).length) continue;

    const { labels, spec: pod } = podTemplate(o, m.kind);
    const containers = list(pod['containers']).map(obj);
    const inits = list(pod['initContainers']).map(obj);
    const appName = labels['app.kubernetes.io/name'] ?? labels['app'];
    const main =
      containers.find(
        (c) => str(c['name']) === m.name || (appName && str(c['name']) === appName),
      ) ??
      containers.find((c) => !isSidecar(c)) ??
      containers[0];

    const env: Record<string, string> = {};
    const lookup = (
      store: Map<string, Record<string, string>>,
      ref: unknown,
      k?: string,
    ): string[] => {
      const data = store.get(key(m.ns, str(obj(ref)['name'])));
      if (!data) return [];
      return k === undefined ? Object.values(data) : data[k] !== undefined ? [data[k]!] : [];
    };
    const refs: string[] = [];
    // Основной контейнер первым: его переменные важнее для угадывания типа.
    for (const c of [...(main ? [main] : []), ...containers.filter((c) => c !== main), ...inits]) {
      for (const e of list(c['env']).map(obj)) {
        const name = str(e['name']);
        const from = obj(e['valueFrom']);
        const value =
          'value' in e
            ? str(e['value'])
            : (lookup(
                configMaps,
                from['configMapKeyRef'],
                str(obj(from['configMapKeyRef'])['key']),
              )[0] ??
              lookup(secrets, from['secretKeyRef'], str(obj(from['secretKeyRef'])['key']))[0] ??
              '');
        if (name && !(name in env)) env[name] = value;
        else if (value) refs.push(value);
      }
      for (const src of list(c['envFrom']).map(obj)) {
        const prefix = str(src['prefix']);
        for (const [store, ref] of [
          [configMaps, src['configMapRef']],
          [secrets, src['secretRef']],
        ] as const) {
          const data = store.get(key(m.ns, str(obj(ref)['name'])));
          for (const [k, v] of Object.entries(data ?? {}))
            if (!(prefix + k in env)) env[prefix + k] = v;
        }
      }
      if (c !== main) refs.push([...list(c['command']), ...list(c['args'])].map(str).join(' '));
    }

    // Примонтированные ConfigMap и Secret: application.yaml, appsettings.json, nginx.conf.
    const mounted: string[] = [];
    for (const v of list(pod['volumes']).map(obj)) {
      const sources = [v, ...list(obj(v['projected'])['sources']).map(obj)];
      for (const s of sources) {
        const cm = str(obj(s['configMap'])['name']);
        const secret = str(obj(s['secret'])['secretName']) || str(obj(s['secret'])['name']);
        if (cm) {
          mounted.push(cm);
          refs.push(...Object.values(configMaps.get(key(m.ns, cm)) ?? {}));
        }
        if (secret) refs.push(...Object.values(secrets.get(key(m.ns, secret)) ?? {}));
      }
    }

    const name = uniqueName(m.name, m.ns);
    for (const cm of mounted) {
      const k = key(m.ns, cm);
      mountedBy.set(k, [...(mountedBy.get(k) ?? []), name]);
    }
    const scale = hpa.get(key(m.ns, m.name));
    const declared = obj(o['spec'])['replicas'];
    let replicas =
      m.kind === 'Pod' || m.kind === 'DaemonSet' || isJob ? 1 : Number(declared ?? scale?.min ?? 1);
    if (!Number.isFinite(replicas)) replicas = 1;
    if (scale && scale.max > replicas)
      notes.push(
        `${name}: ${scale.by} растит его до ${scale.max} реплик, на схеме ${replicas} — модель сама не масштабируется`,
      );
    const queueRefs = keda.get(key(m.ns, m.name));
    if (queueRefs) refs.push(...queueRefs);

    const w: Workload = {
      name,
      ...(main && str(main['image']) ? { image: str(main['image']) } : {}),
      command: main ? [...list(main['command']), ...list(main['args'])].map(str).join(' ') : '',
      env,
      dependsOn: [],
      links: [],
      hostnames: [],
      replicas: Math.max(0, Math.round(replicas)),
      published: false,
      labels,
      mounts: [],
      refs: refs.filter(Boolean),
      origin: m.kind === 'DaemonSet' ? 'DaemonSet, под на каждой ноде' : m.kind,
    };
    if (isJob) {
      w.role = {
        role: { skip: 'job' },
        why: m.kind === 'CronJob' ? 'запускается по расписанию' : 'одноразовая задача',
      };
    } else if (queueRefs) {
      const c = classify({ name, ...(w.image ? { image: w.image } : {}), command: w.command, env });
      if ('kind' in c.role && c.role.kind === 'service')
        w.role = { role: { kind: 'worker' }, why: 'KEDA масштабирует его по очереди' };
    }
    workloads.push(w);
    pods.push({ w, ns: m.ns, labels });
  }

  // ---------- базы и очереди от операторов ----------
  for (const [i, o] of objects.entries()) {
    const m = metas[i]!;
    const op = OPERATORS.find((x) => x.kind === m.kind && x.group.test(m.apiVersion));
    if (!op || !m.name) continue;
    const spec = obj(o['spec']);
    const base = {
      command: '',
      env: {},
      dependsOn: [],
      links: [],
      published: false,
      labels: {},
      mounts: [],
    };
    const replicas = Math.max(1, Math.round(op.replicas(spec) || 1));
    const primary = uniqueName(m.name, m.ns);
    workloads.push({
      ...base,
      name: primary,
      hostnames: op.hosts(m.name).flatMap((h) => dnsNames(h, m.ns)),
      replicas,
      role: { role: { kind: op.role }, why: `${m.kind} от оператора ${op.title}` },
    });
    const readers = op.readers && Math.round(op.readers.count(spec));
    if (op.readers && readers && readers > 0) {
      workloads.push({
        ...base,
        name: uniqueName(m.name + op.readers.suffix, m.ns),
        hostnames: op.readers.hosts(m.name).flatMap((h) => dnsNames(h, m.ns)),
        replicas: readers,
        role: { role: { kind: 'sql-replica' }, why: `реплики для чтения от оператора ${op.title}` },
      });
    }
  }

  // ---------- Service: адреса ворклоадов ----------
  for (const [o, m] of services) {
    const spec = obj(o['spec']);
    const selector = strMap(spec['selector']);
    const type = str(spec['type']);
    if (type === 'ExternalName') {
      notes.push(`${m.name} ведёт наружу, в ${str(spec['externalName'])}, — пропущен`);
      continue;
    }
    const targets = pods
      .filter((p) => p.ns === m.ns && matches(selector, p.labels))
      .map((p) => p.w);
    for (const w of targets) {
      w.hostnames.push(...dnsNames(m.name, m.ns));
      if (type === 'LoadBalancer' || type === 'NodePort') w.published = true;
    }
  }
  // Сервисов в манифестах нет (вставили только Deployment): адресом считаем имя ворклоада.
  if (!services.length) {
    for (const { w, ns } of pods) w.hostnames.push(...dnsNames(w.name, ns));
    if (pods.length > 1)
      notes.push('В манифестах нет Service — адресом ворклоада считается его имя');
  }
  for (const w of workloads) w.hostnames = [...new Set(w.hostnames)];

  // ---------- вход: Ingress, IngressRoute traefik, Gateway API ----------
  const proxies: KubeProxy[] = [];
  const entry = (owner: string, ownerWhy: string, source: string, upstreams: string[]): void => {
    const hosts = [...new Set(upstreams.filter(Boolean))];
    if (hosts.length)
      proxies.push({ source, config: { flavor: 'ingress', upstreams: hosts }, owner, ownerWhy });
  };
  for (const [o, m] of byKind('Ingress')) {
    const spec = obj(o['spec']);
    const cls = str(spec['ingressClassName']) || m.annotations['kubernetes.io/ingress.class'] || '';
    const backend = (b: unknown): string =>
      str(obj(obj(b)['service'])['name']) || str(obj(b)['serviceName']);
    const ups = [
      backend(spec['defaultBackend'] ?? spec['backend']),
      ...list(spec['rules']).flatMap((r) =>
        list(obj(obj(r)['http'])['paths']).map((p) => backend(obj(p)['backend'])),
      ),
    ];
    const owner = cls ? (cls.includes('ingress') ? cls : `ingress-${cls}`) : 'ingress';
    entry(owner, `контроллер Ingress${cls ? ` ${cls}` : ''}`, `Ingress ${m.name}`, ups);
  }
  for (const [o, m] of byKind('IngressRoute')) {
    const ups = list(obj(o['spec'])['routes']).flatMap((r) =>
      list(obj(r)['services']).map((s) => str(obj(s)['name'])),
    );
    entry('traefik', 'IngressRoute traefik', `IngressRoute ${m.name}`, ups);
  }
  for (const kind of ['HTTPRoute', 'GRPCRoute']) {
    for (const [o, m] of byKind(kind)) {
      const spec = obj(o['spec']);
      const gw = str(obj(list(spec['parentRefs'])[0])['name']) || 'gateway';
      const ups = list(spec['rules']).flatMap((r) =>
        list(obj(r)['backendRefs'])
          .map(obj)
          .filter((b) => !b['kind'] || b['kind'] === 'Service')
          .map((b) => str(b['name'])),
      );
      entry(gw, 'Gateway API', `${kind} ${m.name}`, ups);
    }
  }
  // Istio: VirtualService, привязанный к шлюзу, — вход через istio-ingressgateway.
  for (const [o, m] of byKind('VirtualService')) {
    const spec = obj(o['spec']);
    if (!list(spec['gateways']).some((g) => str(g) !== 'mesh')) continue;
    const ups = [...list(spec['http']), ...list(spec['grpc']), ...list(spec['tcp'])].flatMap((r) =>
      list(obj(r)['route']).map((d) => str(obj(obj(d)['destination'])['host'])),
    );
    entry('istio-ingressgateway', 'шлюз Istio', `VirtualService ${m.name}`, ups);
  }

  // ---------- nginx.conf и Caddyfile, лежащие в ConfigMap ----------
  for (const [o, m] of byKind('ConfigMap')) {
    for (const [file, text] of Object.entries(strMap(o['data']))) {
      const config = /caddyfile/i.test(file)
        ? parseCaddyfile(text)
        : /\b(proxy_pass|fastcgi_pass|grpc_pass)\b/.test(text)
          ? parseNginx(text)
          : null;
      if (!config?.upstreams.length) continue;
      const owner = mountedBy.get(key(m.ns, m.name))?.[0];
      proxies.push({
        source: `${file} из ConfigMap ${m.name}`,
        config,
        ...(owner ? { owner } : {}),
      });
    }
  }

  const namespaces = [...new Set(metas.filter((m) => m.kind).map((m) => m.ns))];
  const release = metas.map((m) => m.labels['app.kubernetes.io/instance']).find(Boolean);
  const name = namespaces.length === 1 && namespaces[0] !== 'default' ? namespaces[0] : release;
  if (!workloads.length && !proxies.length)
    throw new KubernetesError(
      'В манифестах нет ворклоадов: нужны Deployment, StatefulSet, DaemonSet или Pod',
    );
  return { ...(name ? { name } : {}), workloads, proxies, notes };
}

/** Похоже на манифест Kubernetes: на верхнем уровне есть apiVersion и kind. */
export function looksLikeKubernetes(text: string): boolean {
  return /^apiVersion\s*:/m.test(text) && /^kind\s*:/m.test(text);
}
