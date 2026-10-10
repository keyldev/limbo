import { readFileSync } from 'node:fs';
import { simulate, validateDocument } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';
import { describe, expect, it } from 'vitest';
import { ImportError, detectSource, importConfigs } from './import.js';
import { SAMPLE_COMPOSE, SAMPLE_KUBERNETES } from './sample.js';

const repo = (path: string): string =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const presets = (JSON.parse(repo('spec/presets/default.json')) as { presets: Preset[] }).presets;

function arrows(doc: LoadlineDocument): string[] {
  const label = new Map(doc.nodes.map((n) => [n.id, n.label]));
  const name = (port: string): string => label.get(port.slice(0, port.lastIndexOf(':')))!;
  return doc.edges
    .map((e) => `${name(e.from)} → ${name(e.to)}${e.only ? ` (${e.only})` : ''}`)
    .sort();
}

const k8s = (text: string) => importConfigs([{ name: 'manifests.yaml', text }]);

/** Deployment с одним контейнером и Service к нему — кирпичик для тестов. */
function app(name: string, image: string, env: Record<string, string> = {}, extra = ''): string {
  const vars = Object.entries(env)
    .map(([k, v]) => `\n            - { name: ${k}, value: "${v}" }`)
    .join('');
  return `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name} }
spec:
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata: { labels: { app: ${name} } }
    spec:
      containers:
        - name: ${name}
          image: ${image}
          env:${vars || ' []'}${extra}
---
apiVersion: v1
kind: Service
metadata: { name: ${name} }
spec:
  selector: { app: ${name} }
---
`;
}

describe('Kubernetes', () => {
  it('пример из окна импорта: ingress, HPA, CloudNativePG, KEDA, Job', () => {
    const { doc, services, notes } = k8s(SAMPLE_KUBERNETES);
    expect(doc.meta.title).toBe('shop');
    expect(arrows(doc)).toEqual([
      'api → orders-mq',
      'api → redis (read)',
      'api → shop-db (write)',
      'ingress-nginx → api',
      'ingress-nginx → web',
      'order-worker → shop-db',
      'orders-mq → order-worker',
      'redis → shop-db-ro',
      'web → api',
      'Клиенты → ingress-nginx',
    ]);
    const by = new Map(services.map((s) => [s.name, s]));
    expect(by.get('api')).toMatchObject({ kind: 'service', replicas: 3 });
    expect(by.get('shop-db-ro')).toMatchObject({ kind: 'sql-replica', replicas: 2 });
    expect(by.get('orders-mq')).toMatchObject({ kind: 'queue', replicas: 3 });
    expect(by.get('migrate')).toMatchObject({ kind: null, skipped: 'job' });
    expect(notes).toContain(
      'api: HPA растит его до 12 реплик, на схеме 3 — модель сама не масштабируется',
    );
    expect(by.get('order-worker')).toMatchObject({ kind: 'worker', replicas: 1 });
    expect(notes).toContain(
      'order-worker: KEDA растит его до 20 реплик, на схеме 1 — модель сама не масштабируется',
    );

    expect(validateDocument(doc)).toEqual([]);
    const r = simulate(doc, { presets, samples: 2000 });
    expect(r.warnings).toEqual([]);
    expect(r.system.servedRps).toBeGreaterThan(0);
  });

  it('узнаётся по apiVersion и kind, с compose не смешивается', () => {
    expect(detectSource('deploy.yaml', 'apiVersion: v1\nkind: Service\n')).toBe('k8s');
    expect(detectSource('docker-compose.yml', 'apiVersion: v1\nkind: Service\n')).toBe('k8s');
    expect(
      detectSource(
        'pasted',
        '# Source: chart/templates/a.yaml\napiVersion: apps/v1\nkind: Deployment\n',
      ),
    ).toBe('k8s');
    expect(() =>
      importConfigs([
        { name: 'docker-compose.yml', text: SAMPLE_COMPOSE },
        { name: 'k8s.yaml', text: SAMPLE_KUBERNETES },
      ]),
    ).toThrow(/что-то одно/);
    expect(() => k8s('apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }\n')).toThrow(
      ImportError,
    );
  });

  it('адреса: короткое имя, FQDN и порт; связь идёт во все ворклоады за Service', () => {
    const text =
      app('api', 'ghcr.io/acme/api', { CATALOG: 'http://catalog.default.svc.cluster.local:8080' }) +
      app('catalog', 'ghcr.io/acme/catalog', { DB: 'Host=pg.default;Port=5432' }) +
      app('pg', 'postgres:17');
    expect(arrows(k8s(text).doc)).toEqual(['api → catalog', 'catalog → pg', 'Клиенты → api']);

    // Один Service выбирает и стабильную версию, и канарейку.
    const canary = `apiVersion: apps/v1
kind: Deployment
metadata: { name: api-canary }
spec:
  replicas: 1
  selector: { matchLabels: { app: api, track: canary } }
  template:
    metadata: { labels: { app: api, track: canary } }
    spec:
      containers: [{ name: api, image: ghcr.io/acme/api }]
---
`;
    const both =
      app('web', 'ghcr.io/acme/web', { API: 'http://api' }) +
      app('api', 'ghcr.io/acme/api') +
      canary;
    expect(arrows(k8s(both).doc)).toEqual(['web → api', 'web → api-canary', 'Клиенты → web']);
  });

  it('kubectl get -o yaml: List раскрывается, поды и ReplicaSet с владельцем не дублируют Deployment', () => {
    const list = `apiVersion: v1
kind: List
items:
  - apiVersion: apps/v1
    kind: Deployment
    metadata: { name: api, namespace: prod }
    spec:
      replicas: 4
      selector: { matchLabels: { app: api } }
      template:
        metadata: { labels: { app: api } }
        spec:
          containers:
            - name: api
              image: ghcr.io/acme/api:1
              env: [{ name: REDIS_HOST, value: redis.prod.svc }]
  - apiVersion: apps/v1
    kind: ReplicaSet
    metadata:
      name: api-7d9c
      namespace: prod
      ownerReferences: [{ kind: Deployment, name: api }]
    spec:
      replicas: 4
      template:
        metadata: { labels: { app: api } }
        spec: { containers: [{ name: api, image: ghcr.io/acme/api:1 }] }
  - apiVersion: v1
    kind: Pod
    metadata:
      name: api-7d9c-x2v
      namespace: prod
      labels: { app: api }
      ownerReferences: [{ kind: ReplicaSet, name: api-7d9c }]
    spec: { containers: [{ name: api, image: ghcr.io/acme/api:1 }] }
  - apiVersion: v1
    kind: Pod
    metadata: { name: redis, namespace: prod, labels: { app: redis } }
    spec: { containers: [{ name: redis, image: redis:7 }] }
  - apiVersion: v1
    kind: Service
    metadata: { name: redis, namespace: prod }
    spec: { selector: { app: redis } }
  - apiVersion: v1
    kind: Service
    metadata: { name: api, namespace: prod }
    spec: { type: LoadBalancer, selector: { app: api } }
`;
    const { doc, services } = k8s(list);
    expect(services.map((s) => s.name)).toEqual(['api', 'redis']);
    expect(doc.meta.title).toBe('prod');
    expect(doc.nodes.find((n) => n.label === 'api')?.params).toEqual({ replicas: 4 });
    expect(arrows(doc)).toEqual(['api → redis', 'Клиенты → api']);
  });

  it('переменные из ConfigMap и Secret, sidecar не путает тип', () => {
    const text =
      `apiVersion: v1
kind: Secret
metadata: { name: db }
data:
  url: ${btoa('postgres://app:pw@orders-db:5432/app')}
---
apiVersion: v1
kind: ConfigMap
metadata: { name: settings }
data:
  application.yaml: |
    spring:
      kafka:
        bootstrap-servers: events:9092
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: orders }
spec:
  selector: { matchLabels: { app: orders } }
  template:
    metadata: { labels: { app: orders } }
    spec:
      volumes:
        - name: cfg
          configMap: { name: settings }
      containers:
        - name: istio-proxy
          image: docker.io/istio/proxyv2:1.23.0
        - name: app
          image: ghcr.io/acme/orders:3
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: db, key: url } }
---
` +
      app('orders-db', 'postgres:17') +
      app('events', 'bitnami/kafka:3.8');
    const { doc, services } = k8s(text);
    expect(services.find((s) => s.name === 'orders')).toMatchObject({
      kind: 'service',
      why: 'Deployment, образ orders',
    });
    expect(arrows(doc)).toEqual(['orders → events', 'orders → orders-db', 'Клиенты → orders']);
  });

  it('nginx.conf из ConfigMap: апстримы становятся связями от того, кто его монтирует', () => {
    const text =
      `apiVersion: v1
kind: ConfigMap
metadata: { name: edge-conf }
data:
  default.conf: |
    upstream backend { server api:8080; server api-2:8080; }
    server {
      location / { proxy_pass http://backend; }
      location /static/ { proxy_pass http://assets.default.svc.cluster.local; }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: edge }
spec:
  selector: { matchLabels: { app: edge } }
  template:
    metadata: { labels: { app: edge } }
    spec:
      volumes: [{ name: conf, configMap: { name: edge-conf } }]
      containers: [{ name: nginx, image: nginx:1.27 }]
---
apiVersion: v1
kind: Service
metadata: { name: edge }
spec: { type: LoadBalancer, selector: { app: edge } }
---
` +
      app('api', 'ghcr.io/acme/api') +
      app('assets', 'ghcr.io/acme/assets');
    const { doc } = k8s(text);
    expect(arrows(doc)).toEqual(['edge → api', 'edge → api-2', 'edge → assets', 'Клиенты → edge']);
  });

  it('Gateway API и IngressRoute traefik — вход через свой балансировщик', () => {
    const route = `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: store }
spec:
  parentRefs: [{ name: public-gw }]
  rules:
    - backendRefs: [{ name: web, port: 80 }]
    - matches: [{ path: { value: /api } }]
      backendRefs: [{ name: api, port: 80 }, { kind: ServiceImport, name: elsewhere }]
---
`;
    const { doc, services } = k8s(
      route + app('web', 'ghcr.io/acme/web') + app('api', 'ghcr.io/acme/api'),
    );
    expect(services.find((s) => s.name === 'public-gw')).toMatchObject({
      kind: 'load-balancer',
      why: 'Gateway API',
    });
    expect(arrows(doc)).toEqual(['public-gw → api', 'public-gw → web', 'Клиенты → public-gw']);

    const traefik = `apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata: { name: site }
spec:
  routes:
    - match: Host(\`example.com\`)
      services: [{ name: web, port: 80 }]
---
`;
    expect(arrows(k8s(traefik + app('web', 'ghcr.io/acme/web')).doc)).toEqual([
      'traefik → web',
      'Клиенты → traefik',
    ]);
  });

  it('без Service адресом считается имя ворклоада; DaemonSet и CronJob', () => {
    const deploy = (name: string, image: string, env = '[]') => `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name} }
spec:
  template:
    spec:
      containers: [{ name: ${name}, image: ${image}, env: ${env} }]
---
`;
    const text =
      deploy('api', 'ghcr.io/acme/api', '[{ name: CACHE, value: "memcached:11211" }]') +
      deploy('memcached', 'memcached:1.6') +
      `apiVersion: apps/v1
kind: DaemonSet
metadata: { name: logs }
spec:
  template:
    spec:
      containers: [{ name: fluent-bit, image: fluent/fluent-bit:3 }]
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-report }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers: [{ name: report, image: ghcr.io/acme/api, args: [report, --db, api] }]
`;
    const { doc, services, notes } = k8s(text);
    expect(arrows(doc)).toEqual(['api → memcached', 'Клиенты → api']);
    expect(services.find((s) => s.name === 'logs')).toMatchObject({ kind: null, skipped: 'infra' });
    expect(services.find((s) => s.name === 'nightly-report')).toMatchObject({
      skipped: 'job',
      why: 'CronJob, запускается по расписанию',
    });
    expect(notes).toContain('В манифестах нет Service — адресом ворклоада считается его имя');
  });

  it('ExternalName и внешние апстримы Ingress не становятся узлами', () => {
    const text =
      app('api', 'ghcr.io/acme/api', { PAYMENTS: 'https://payments' }) +
      `apiVersion: v1
kind: Service
metadata: { name: payments }
spec: { type: ExternalName, externalName: api.stripe.com }
`;
    const { doc, notes } = k8s(text);
    expect(arrows(doc)).toEqual(['Клиенты → api']);
    expect(notes).toContain('payments ведёт наружу, в api.stripe.com, — пропущен');
  });
});
