import { readFileSync } from 'node:fs';
import { simulate, validateDocument } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';
import { describe, expect, it } from 'vitest';
import { classify, imageName } from './classify.js';
import { ImportError, detectSource, importConfigs } from './import.js';
import { parseCaddyfile, parseNginx } from './proxy.js';
import { SAMPLE_COMPOSE } from './sample.js';

const repo = (path: string): string => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const presets = (JSON.parse(repo('spec/presets/default.json')) as { presets: Preset[] }).presets;

/** Связи как «от → к» по подписям узлов, чтобы тесты читались. */
function arrows(doc: LoadlineDocument): string[] {
  const label = new Map(doc.nodes.map((n) => [n.id, n.label]));
  const name = (port: string): string => label.get(port.slice(0, port.lastIndexOf(':')))!;
  return doc.edges
    .map((e) => `${name(e.from)} → ${name(e.to)}${e.only ? ` (${e.only})` : ''}`)
    .sort();
}

function kinds(doc: LoadlineDocument): Record<string, string> {
  return Object.fromEntries(doc.nodes.map((n) => [n.label, n.kind]));
}

describe('classify', () => {
  it.each([
    ['postgres:17-alpine', 'sql-primary'],
    ['bitnami/postgresql:16', 'sql-primary'],
    ['mcr.microsoft.com/mssql/server:2022-latest', 'sql-primary'],
    ['redis/redis-stack:latest', 'cache'],
    ['confluentinc/cp-kafka:7.6.0', 'queue'],
    ['docker.elastic.co/elasticsearch/elasticsearch:8.15.0', 'search'],
    ['minio/minio', 'object-storage'],
    ['mongo:7', 'nosql'],
    ['traefik:v3.1', 'load-balancer'],
    ['kong:3.7', 'api-gateway'],
    ['varnish:7', 'cdn'],
    ['ghcr.io/acme/api:1.4.2', 'service'],
  ])('%s → %s', (image, kind) => {
    expect(classify({ name: 'x', image, command: '', env: {} }).role).toEqual({ kind });
  });

  it.each([
    ['prom/prometheus', 'infra'],
    ['grafana/grafana', 'infra'],
    ['prometheuscommunity/postgres-exporter', 'infra'],
    ['mongo-express', 'infra'],
    ['provectuslabs/kafka-ui', 'infra'],
    ['grafana/k6', 'infra'],
    ['locustio/locust', 'infra'],
    ['edoburu/pgbouncer', 'proxy'],
  ])('%s пропускается как %s', (image, skip) => {
    expect(classify({ name: 'x', image, command: '', env: {} }).role).toEqual({ skip });
  });

  it('свой build узнаётся по имени и по команде', () => {
    const k = (name: string, command = '') => classify({ name, command, env: {} }).role;
    expect(k('db')).toEqual({ kind: 'sql-primary' });
    expect(k('redis-worker')).toEqual({ kind: 'worker' });
    expect(k('backend', 'celery -A app worker')).toEqual({ kind: 'worker' });
    expect(k('backend', 'bundle exec sidekiq')).toEqual({ kind: 'worker' });
    expect(k('db-migrate')).toEqual({ skip: 'job' });
    expect(k('backend')).toEqual({ kind: 'service' });
  });

  it('порт сильнее имени: свой образ user-db на 27017 — MongoDB, queue-master на 80 — сервис', () => {
    const c = (name: string, ports: string[], image = `weaveworksdemos/${name}:0.3.0`) =>
      classify({ name, image, command: '', env: {}, ports });
    expect(c('user-db', ['27017', 'mongo'])).toEqual({ role: { kind: 'nosql' }, why: 'порт 27017' });
    expect(c('catalogue-db', ['3306']).role).toEqual({ kind: 'sql-primary' });
    expect(c('sessions', ['redis']).role).toEqual({ kind: 'cache' });
    expect(c('queue-master', ['80'])).toEqual({
      role: { kind: 'service' },
      why: '«queue» в имени, но слушает HTTP-порт 80',
    });
    expect(c('queue', []).role).toEqual({ kind: 'queue' });
    // Образ сильнее порта: nginx на 6379 остаётся балансировщиком.
    expect(c('edge', ['6379'], 'nginx:1.27').role).toEqual({ kind: 'load-balancer' });
  });

  it('реплика базы — по имени или по переменной bitnami', () => {
    expect(
      classify({ name: 'postgres-replica', image: 'postgres:17', command: '', env: {} }).role,
    ).toEqual({ kind: 'sql-replica' });
    expect(
      classify({
        name: 'pg-2',
        image: 'bitnami/postgresql',
        command: '',
        env: { POSTGRESQL_REPLICATION_MODE: 'slave' },
      }).role,
    ).toEqual({ kind: 'sql-replica' });
  });

  it('imageName отрезает тег и дайджест, но не порт реестра', () => {
    expect(imageName('localhost:5000/acme/api:1.2@sha256:abc')).toBe('localhost:5000/acme/api');
    expect(imageName('Postgres')).toBe('postgres');
  });
});

describe('конфиги прокси', () => {
  it('Caddyfile: reverse_proxy, матчеры, блок с to, плейсхолдеры', () => {
    const caddy = parseCaddyfile(`
      example.com {
        reverse_proxy /api/* api:8080 api-2:8080
        reverse_proxy @ws http://realtime:3000
        reverse_proxy {
          to h2c://grpc:50051
          lb_policy round_robin
        }
        reverse_proxy {$UPSTREAM}
        # reverse_proxy old:80
      }
    `);
    expect(caddy.upstreams).toEqual(['api', 'api-2', 'realtime', 'grpc']);
  });

  it('nginx: proxy_pass в upstream раскрывается в его серверы', () => {
    const nginx = parseNginx(`
      upstream backend { server api-1:8080; server api-2:8080 weight=2; }
      server {
        location / { proxy_pass http://backend; }
        location /static/ { proxy_pass http://static:80/; }
        location ~ \\.php$ { fastcgi_pass php:9000; }
        location /x { proxy_pass http://$upstream; }
      }
    `);
    expect(nginx.upstreams).toEqual(['api-1', 'api-2', 'static', 'php']);
  });

  it('тип конфига по имени файла и по содержимому', () => {
    expect(detectSource('docker-compose.prod.yml', '')).toBe('compose');
    expect(detectSource('deploy/compose.yaml', '')).toBe('compose');
    expect(detectSource('Caddyfile', '')).toBe('caddy');
    expect(detectSource('default.conf', '')).toBe('nginx');
    expect(detectSource('вставка', 'services:\n  a: {}')).toBe('compose');
    expect(detectSource('вставка', ':80 {\n  reverse_proxy app:3000\n}')).toBe('caddy');
    expect(detectSource('вставка', 'hello')).toBeNull();
  });
});

describe('importConfigs', () => {
  it('пример: прокси, API за кэшем, воркер за очередью, задачи и обвязка пропущены', () => {
    const { doc, services, notes } = importConfigs([{ name: 'compose.yaml', text: SAMPLE_COMPOSE }]);
    expect(kinds(doc)).toEqual({
      Клиенты: 'client',
      nginx: 'load-balancer',
      api: 'service',
      worker: 'worker',
      redis: 'cache',
      postgres: 'sql-primary',
      rabbitmq: 'queue',
    });
    expect(arrows(doc)).toEqual([
      'api → rabbitmq',
      'api → redis',
      'nginx → api',
      'rabbitmq → worker',
      'redis → postgres',
      'worker → postgres',
      'Клиенты → nginx',
    ]);
    expect(doc.nodes.find((n) => n.label === 'api')?.params).toEqual({ replicas: 2 });
    expect(doc.edges.find((e) => e.to === 'rabbitmq:in')?.mode).toBe('parallel');
    expect(services.find((s) => s.name === 'migrate')).toMatchObject({ kind: null, skipped: 'job' });
    expect(services.find((s) => s.name === 'grafana')).toMatchObject({ kind: null, skipped: 'infra' });
    expect(notes).toContain('redis стоит перед postgres: в базу идут только промахи кэша');
    expect(notes).toContain('rabbitmq отдаёт задачи воркеру worker');
  });

  it('свой деплой limbo: compose и Caddyfile из deploy/', () => {
    const { doc, services } = importConfigs([
      { name: 'compose.yaml', text: repo('deploy/compose.yaml') },
      { name: 'Caddyfile', text: repo('deploy/Caddyfile') },
    ]);
    expect(arrows(doc)).toEqual(['api → postgres', 'caddy → api', 'Клиенты → caddy']);
    expect(services.find((s) => s.name === 'migrate')?.skipped).toBe('job');
  });

  it('результат проходит проверку формата и считается движком', () => {
    for (const text of [SAMPLE_COMPOSE, repo('deploy/compose.yaml')]) {
      const { doc } = importConfigs([{ name: 'compose.yaml', text }]);
      expect(validateDocument(doc)).toEqual([]);
      const r = simulate(doc, { presets, samples: 2000 });
      expect(r.warnings).toEqual([]);
      expect(r.system.incomingRps).toBe(1000);
      expect(r.system.servedRps).toBeGreaterThan(0);
    }
  });

  it('у воркера redis — брокер, а не кэш перед базой (example-voting-app)', () => {
    const { doc } = importConfigs([
      {
        name: 'compose.yaml',
        text: `services:
  vote:
    build: ./vote
    ports: ["8080:80"]
    depends_on: [redis]
  result:
    build: ./result
    ports: ["8081:80"]
    depends_on: [db]
  worker:
    build: ./worker
    depends_on: [redis, db]
  redis: { image: redis:alpine }
  db: { image: postgres:15-alpine }
`,
      },
    ]);
    expect(arrows(doc)).toEqual([
      'result → db',
      'vote → redis',
      'worker → db',
      'worker → redis',
      'Клиенты → result',
      'Клиенты → vote',
    ]);
  });

  it('основная база и реплика: чтения в реплику, записи в основную', () => {
    const { doc } = importConfigs([
      {
        name: 'compose.yaml',
        text: `services:
  api:
    image: acme/api
    ports: ["8080:8080"]
    environment:
      DB_PRIMARY: Host=pg;Port=5432
      DB_REPLICA: Host=pg-replica;Port=5432
  pg: { image: postgres:17 }
  pg-replica: { image: postgres:17 }
`,
      },
    ]);
    expect(arrows(doc)).toEqual(['api → pg (write)', 'api → pg-replica (read)', 'Клиенты → api']);
  });

  it('traefik ведёт в сервисы с метками, ${VAR:-default} даёт имя хоста', () => {
    const { doc } = importConfigs([
      {
        name: 'compose.yaml',
        text: `services:
  traefik:
    image: traefik:v3.1
    ports: ["80:80"]
  web:
    image: acme/web
    labels:
      - traefik.enable=true
    environment:
      - SEARCH_URL=http://\${SEARCH_HOST:-meili}:7700
  admin:
    image: acme/admin
    labels:
      traefik.http.routers.admin.rule: Host(\`admin.local\`)
  meili:
    image: getmeili/meilisearch:v1.10
`,
      },
    ]);
    expect(arrows(doc)).toEqual([
      'traefik → admin',
      'traefik → web',
      'web → meili',
      'Клиенты → traefik',
    ]);
  });

  it('без балансировщика клиенты приходят в опубликованные сервисы', () => {
    const { doc, notes } = importConfigs([
      {
        name: 'compose.yaml',
        text: `services:
  app: { build: ., ports: ["3000:3000"], depends_on: [db] }
  db: { image: mysql:8 }
`,
      },
    ]);
    expect(arrows(doc)).toEqual(['app → db', 'Клиенты → app']);
    expect(notes[0]).toBe('Клиенты приходят в app');
  });

  it('compose для разработки, только с базами: клиенты не идут в базу', () => {
    const { doc, notes } = importConfigs([
      {
        name: 'docker-compose.yml',
        text: `services:
  postgres: { image: postgres:17, ports: ["5432:5432"] }
  redis: { image: redis:7, ports: ["6379:6379"] }
`,
      },
    ]);
    expect(doc.edges).toEqual([]);
    expect(notes[0]).toMatch(/окружение для разработки/);
  });

  it('связи против пути запроса и циклы убираются', () => {
    const { doc, notes } = importConfigs([
      {
        name: 'compose.yaml',
        text: `services:
  a: { image: acme/a, ports: ["80:80"], environment: { PEER: "http://b" } }
  b: { image: acme/b, environment: { PEER: "http://a", DB: "postgres://postgres/x" } }
  postgres: { image: postgres, environment: { POSTGRES_USER: a } }
`,
      },
    ]);
    expect(arrows(doc)).toEqual(['a → b', 'b → postgres', 'Клиенты → a']);
    expect(notes).toContain('Связь b → a убрана: она замыкала цикл');
  });

  it('один Caddyfile без compose тоже даёт схему', () => {
    const { doc, notes } = importConfigs([
      { name: 'Caddyfile', text: 'example.com {\n  reverse_proxy app:3000 legacy.example.org:80\n}' },
    ]);
    expect(kinds(doc)).toEqual({ Клиенты: 'client', caddy: 'load-balancer', app: 'service' });
    expect(arrows(doc)).toEqual(['caddy → app', 'Клиенты → caddy']);
    expect(notes).toContain('legacy.example.org из Caddyfile — не контейнер compose, пропущен');
  });

  it('override-файл дополняет основной', () => {
    const { doc } = importConfigs([
      { name: 'compose.yaml', text: 'services:\n  api: { image: acme/api, ports: ["80:80"] }\n' },
      { name: 'compose.override.yaml', text: 'services:\n  api: { deploy: { replicas: 3 } }\n' },
    ]);
    expect(doc.nodes.find((n) => n.label === 'api')?.params).toEqual({ replicas: 3 });
  });

  it('понятные ошибки', () => {
    expect(() => importConfigs([])).toThrow(ImportError);
    expect(() => importConfigs([{ name: 'compose.yaml', text: 'services: [' }])).toThrow(
      /YAML не разобрался/,
    );
    expect(() => importConfigs([{ name: 'compose.yaml', text: 'version: "3"' }])).toThrow(
      /нет раздела services/,
    );
    expect(() => importConfigs([{ name: 'notes.txt', text: 'hello' }])).toThrow(/не похоже/);
  });
});
