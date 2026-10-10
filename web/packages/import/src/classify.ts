import type { NodeKind } from '@loadline/model';

/**
 * Во что превращается контейнер:
 * - узел схемы нужного типа;
 * - job — одноразовая задача (миграции, сиды): узла нет, связи проводятся сквозь неё;
 * - proxy — прозрачный посредник (пулер соединений): узла нет, связи тоже проводятся сквозь;
 * - infra — обвязка (мониторинг, админки, почта для разработки): узла нет, связи выбрасываются.
 */
export type Role = { kind: NodeKind } | { skip: 'job' | 'proxy' | 'infra' };

export interface Classified {
  role: Role;
  /** Почему так решили — показывается человеку перед импортом. */
  why: string;
}

/** Пресет по умолчанию для типа — тот же, что ставит палитра (app/src/app/catalog/kinds.ts). */
export const DEFAULT_PRESET: Record<NodeKind, string> = {
  client: 'client.default',
  cdn: 'cdn.default',
  'load-balancer': 'lb.default',
  'api-gateway': 'gateway.default',
  service: 'service.small',
  worker: 'worker.small',
  cache: 'cache.redis-small',
  'sql-primary': 'sql.primary-medium',
  'sql-replica': 'sql.replica-medium',
  nosql: 'nosql.default',
  queue: 'queue.default',
  'object-storage': 'storage.object',
  search: 'search.default',
};

const words = (s: string): ReadonlySet<string> => new Set(s.trim().split(/\s+/));

/** Слова из имени образа, по которым узнаём тип. Порядок важен: обвязка проверяется первой. */
const IMAGE_WORDS: readonly (readonly [Role, ReadonlySet<string>])[] = [
  [
    { skip: 'infra' },
    words(`
      prometheus grafana loki tempo mimir jaeger zipkin opentelemetry otel alertmanager exporter
      cadvisor promtail fluentd fluent fluentbit logstash kibana filebeat metricbeat netdata
      pgadmin pgadmin4 adminer phpmyadmin redisinsight kafdrop akhq portainer watchtower dozzle
      mailhog mailpit maildev smtp4dev certbot zookeeper consul vault etcd sentry uptime
      loadgenerator locust k6 jmeter gatling vegeta artillery wrk
    `),
  ],
  [{ skip: 'proxy' }, words('pgbouncer pgpool pgcat odyssey proxysql maxscale twemproxy')],
  [
    { kind: 'sql-primary' },
    words(`
      postgres postgresql postgis timescaledb pgvector mysql mariadb percona mssql sqlserver
      cockroach cockroachdb yugabytedb tidb oracle
    `),
  ],
  [{ kind: 'cache' }, words('redis valkey keydb memcached dragonfly dragonflydb garnet')],
  [
    { kind: 'nosql' },
    words(`
      mongo mongodb cassandra scylla scylladb couchdb couchbase arangodb neo4j dynamodb ravendb
      surrealdb clickhouse influxdb
    `),
  ],
  [
    { kind: 'queue' },
    words(`
      rabbitmq kafka redpanda nats activemq artemis pulsar nsq nsqd emqx mosquitto elasticmq
      beanstalkd
    `),
  ],
  [{ kind: 'object-storage' }, words('minio seaweedfs garage ceph localstack azurite gcs')],
  [
    { kind: 'search' },
    words('elasticsearch opensearch meilisearch typesense solr manticore manticoresearch quickwit'),
  ],
  [{ kind: 'api-gateway' }, words('kong tyk krakend apisix gravitee')],
  [{ kind: 'load-balancer' }, words('nginx caddy traefik haproxy envoy openresty angie')],
  [{ kind: 'cdn' }, words('varnish')],
];

/** Образы-админки, которые по словам похожи на базу или очередь. */
const INFRA_IMAGES = words('mongo-express redis-commander kafka-ui');

/** Слова из имени сервиса, если образ ничего не сказал (свой build, незнакомый образ). */
const NAME_WORDS: readonly (readonly [Role, ReadonlySet<string>])[] = [
  [
    { skip: 'job' },
    words('migrate migrator migration migrations seed seeder seeds init setup bootstrap'),
  ],
  [
    { kind: 'worker' },
    words(`
      worker workers consumer consumers celery sidekiq scheduler beat cron jobs job processor
      dramatiq rq hangfire
    `),
  ],
  [{ kind: 'sql-primary' }, words('db database sql')],
  [{ kind: 'cache' }, words('cache')],
  [{ kind: 'queue' }, words('queue broker mq bus')],
  [{ kind: 'search' }, words('search')],
  [{ kind: 'api-gateway' }, words('gateway')],
  [{ kind: 'load-balancer' }, words('proxy lb balancer ingress')],
];

const REPLICA_WORDS = words('replica replicas slave standby read ro secondary follower');

/**
 * Известные порты: по ним узнаётся база или брокер в своём образе (weaveworksdemos/user-db
 * слушает 27017 — это MongoDB, хотя в имени «db»). Неоднозначные (9000, 8080) не берём.
 */
const PORT_WORDS: Readonly<Record<string, string>> = {
  '5432': 'postgres',
  '3306': 'mysql',
  '1433': 'mssql',
  '26257': 'cockroachdb',
  '1521': 'oracle',
  '27017': 'mongo',
  '9042': 'cassandra',
  '7687': 'neo4j',
  '5984': 'couchdb',
  '6379': 'redis',
  '11211': 'memcached',
  '5672': 'rabbitmq',
  '9092': 'kafka',
  '4222': 'nats',
  '61616': 'activemq',
  '1883': 'mosquitto',
  '9200': 'elasticsearch',
  '7700': 'meilisearch',
  '8108': 'typesense',
};

/** Порты, на которых обычно слушает HTTP-приложение, а не база или брокер. */
const HTTP_PORTS = words('80 443 3000 5000 8000 8080 8443 http https');

const DATA_KINDS: ReadonlySet<NodeKind> = new Set([
  'cache',
  'queue',
  'sql-primary',
  'sql-replica',
  'nosql',
  'object-storage',
  'search',
]);

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Имя образа без реестра, тега и дайджеста: ghcr.io/org/api:1.2@sha256:… → ghcr.io/org/api. */
export function imageName(image: string): string {
  const noDigest = image.split('@')[0]!;
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  return (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase();
}

function match(
  rules: readonly (readonly [Role, ReadonlySet<string>])[],
  toks: readonly string[],
): { role: Role; word: string } | null {
  for (const [role, set] of rules) {
    const word = toks.find((t) => set.has(t));
    if (word) return { role, word };
  }
  return null;
}

export interface ServiceFacts {
  name: string;
  image?: string;
  /** command и entrypoint одной строкой: celery worker, sidekiq и т. п. */
  command: string;
  env: Readonly<Record<string, string>>;
  /** Порты контейнера: номера и имена (в k8s у порта бывает имя mongo, mysql). */
  ports?: readonly string[];
}

/** Угадывает роль контейнера по образу, имени и команде. */
export function classify(s: ServiceFacts): Classified {
  const image = s.image ? imageName(s.image) : '';
  const base = image.slice(image.lastIndexOf('/') + 1);
  const nameToks = tokens(s.name);
  const cmdToks = tokens(s.command);

  // Одноразовые задачи часто собраны из образа API — имя говорит больше образа.
  const job = match(NAME_WORDS.slice(0, 1), nameToks);
  if (job) return { role: job.role, why: `одноразовая задача: «${job.word}» в имени` };

  let found: Classified | null = null;
  if (INFRA_IMAGES.has(base)) found = { role: { skip: 'infra' }, why: `образ ${base}` };
  else {
    const byImage = image ? match(IMAGE_WORDS, tokens(image)) : null;
    if (byImage) found = { role: byImage.role, why: `образ ${base || image}` };
  }
  if (!found && s.ports?.length) {
    // Порт говорит о технологии точнее имени, но обвязку по нему не узнать.
    const portToks = s.ports.flatMap((p) => [PORT_WORDS[p] ?? '', ...tokens(p)]).filter(Boolean);
    const byPort = match(IMAGE_WORDS.slice(2), portToks);
    if (byPort) {
      const port = s.ports.find((p) => PORT_WORDS[p] === byPort.word || tokens(p).includes(byPort.word));
      found = { role: byPort.role, why: `порт ${port}` };
    }
  }
  if (!found) {
    // redis-worker — это воркер, а не кэш: в имени «воркер» сильнее названия технологии.
    const byName = match([NAME_WORDS[1]!, ...IMAGE_WORDS, ...NAME_WORDS.slice(2)], nameToks);
    // queue-master на порту 80 — сервис, который работает с очередью, а не сама очередь.
    const http = s.ports?.find((p) => HTTP_PORTS.has(p));
    if (byName && http && 'kind' in byName.role && DATA_KINDS.has(byName.role.kind))
      found = { role: { kind: 'service' }, why: `«${byName.word}» в имени, но слушает HTTP-порт ${http}` };
    else if (byName) found = { role: byName.role, why: `«${byName.word}» в имени` };
  }
  if (!found) {
    const byCmd = match(NAME_WORDS.slice(1, 2), cmdToks);
    if (byCmd) found = { role: byCmd.role, why: `команда ${byCmd.word}` };
  }
  found ??= { role: { kind: 'service' }, why: s.image ? `образ ${base}` : 'свой build' };

  // Сервис, который запускает воркер из того же образа (celery worker, sidekiq).
  if ('kind' in found.role && found.role.kind === 'service') {
    const cmd = match(NAME_WORDS.slice(1, 2), cmdToks);
    if (cmd) return { role: { kind: 'worker' }, why: `команда ${cmd.word}` };
  }

  if ('kind' in found.role && found.role.kind === 'sql-primary' && isReplica(s, nameToks)) {
    return { role: { kind: 'sql-replica' }, why: `${found.why}, реплика` };
  }
  return found;
}

function isReplica(s: ServiceFacts, nameToks: readonly string[]): boolean {
  if (nameToks.some((t) => REPLICA_WORDS.has(t))) return true;
  // bitnami/postgresql, bitnami/mysql: POSTGRESQL_REPLICATION_MODE=slave
  return Object.entries(s.env).some(
    ([k, v]) => /REPLICATION_MODE$/i.test(k) && /^(slave|replica|standby)$/i.test(v),
  );
}
