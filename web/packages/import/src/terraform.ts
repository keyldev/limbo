import type { NodeKind } from '@loadline/model';
import { HclError, parseHcl, type HclBlock } from './hcl.js';
import type { Workload } from './workload.js';

export interface TerraformPlan {
  name?: string;
  workloads: Workload[];
  notes: string[];
}

export class TerraformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerraformError';
  }
}

/** Что за узел ресурс и откуда брать число реплик. */
interface Kind {
  kind: NodeKind;
  /** Атрибуты с числом реплик по порядку: первый найденный побеждает. */
  replicas?: readonly string[];
}

const k = (kind: NodeKind, ...replicas: string[]): Kind => ({ kind, replicas });

/** Ресурсы, которые становятся узлами. Всё остальное — клей (связи) или обвязка. */
const RESOURCES: Readonly<Record<string, Kind>> = {
  // AWS
  aws_cloudfront_distribution: k('cdn'),
  aws_lb: k('load-balancer'),
  aws_alb: k('load-balancer'),
  aws_elb: k('load-balancer'),
  aws_api_gateway_rest_api: k('api-gateway'),
  aws_apigatewayv2_api: k('api-gateway'),
  aws_ecs_service: k('service', 'desired_count'),
  aws_lambda_function: k('service'),
  aws_instance: k('service'),
  aws_autoscaling_group: k('service', 'desired_capacity', 'min_size'),
  aws_apprunner_service: k('service'),
  aws_elastic_beanstalk_environment: k('service'),
  aws_db_instance: k('sql-primary'),
  aws_rds_cluster: k('sql-primary'),
  aws_elasticache_cluster: k('cache', 'num_cache_nodes'),
  aws_elasticache_replication_group: k('cache', 'num_cache_clusters', 'num_node_groups'),
  aws_elasticache_serverless_cache: k('cache'),
  aws_memorydb_cluster: k('cache', 'num_shards'),
  aws_dynamodb_table: k('nosql'),
  aws_docdb_cluster: k('nosql'),
  aws_keyspaces_table: k('nosql'),
  aws_sqs_queue: k('queue'),
  aws_sns_topic: k('queue'),
  aws_msk_cluster: k('queue', 'number_of_broker_nodes'),
  aws_mq_broker: k('queue'),
  aws_kinesis_stream: k('queue', 'shard_count'),
  aws_s3_bucket: k('object-storage'),
  aws_opensearch_domain: k('search'),
  aws_elasticsearch_domain: k('search'),
  // Сервис из карты services модуля terraform-aws-modules/ecs.
  'ecs-service': k('service', 'desired_count'),
  // Google Cloud
  google_compute_url_map: k('load-balancer'),
  google_api_gateway_gateway: k('api-gateway'),
  google_cloud_run_service: k('service'),
  google_cloud_run_v2_service: k('service'),
  google_cloudfunctions_function: k('service'),
  google_cloudfunctions2_function: k('service'),
  google_compute_instance: k('service'),
  google_compute_instance_group_manager: k('service', 'target_size'),
  google_compute_region_instance_group_manager: k('service', 'target_size'),
  google_app_engine_standard_app_version: k('service'),
  google_sql_database_instance: k('sql-primary'),
  google_spanner_instance: k('sql-primary', 'num_nodes'),
  google_alloydb_cluster: k('sql-primary'),
  google_redis_instance: k('cache'),
  google_memcache_instance: k('cache', 'node_count'),
  google_firestore_database: k('nosql'),
  google_bigtable_instance: k('nosql'),
  google_pubsub_topic: k('queue'),
  google_storage_bucket: k('object-storage'),
  // Azure
  azurerm_cdn_frontdoor_profile: k('cdn'),
  azurerm_cdn_profile: k('cdn'),
  azurerm_frontdoor: k('cdn'),
  azurerm_application_gateway: k('load-balancer'),
  azurerm_lb: k('load-balancer'),
  azurerm_api_management: k('api-gateway'),
  azurerm_linux_web_app: k('service'),
  azurerm_windows_web_app: k('service'),
  azurerm_app_service: k('service'),
  azurerm_container_app: k('service'),
  azurerm_linux_function_app: k('service'),
  azurerm_windows_function_app: k('service'),
  azurerm_function_app: k('service'),
  azurerm_linux_virtual_machine: k('service'),
  azurerm_linux_virtual_machine_scale_set: k('service', 'instances'),
  azurerm_postgresql_flexible_server: k('sql-primary'),
  azurerm_postgresql_server: k('sql-primary'),
  azurerm_mysql_flexible_server: k('sql-primary'),
  azurerm_mssql_server: k('sql-primary'),
  azurerm_mssql_database: k('sql-primary'),
  azurerm_redis_cache: k('cache'),
  azurerm_cosmosdb_account: k('nosql'),
  azurerm_servicebus_queue: k('queue'),
  azurerm_servicebus_topic: k('queue'),
  azurerm_eventhub: k('queue', 'partition_count'),
  azurerm_storage_account: k('object-storage'),
  azurerm_search_service: k('search', 'replica_count'),
};

/** Модули из реестра: по адресу source. terraform-aws-modules/rds/aws → SQL. */
const MODULES: readonly (readonly [RegExp, NodeKind])[] = [
  [/(^|\/)(rds|rds-aurora|aurora|postgresql|mysql|cloud-sql|sql-db)(\/|$)/, 'sql-primary'],
  [/(^|\/)(elasticache|memorystore|redis)(\/|$)/, 'cache'],
  [/(^|\/)(alb|elb|lb|load-balancer|lb-http)(\/|$)/, 'load-balancer'],
  [/(^|\/)(cloudfront|cdn)(\/|$)/, 'cdn'],
  [/(^|\/)(apigateway-v2|api-gateway)(\/|$)/, 'api-gateway'],
  [/(^|\/)(sqs|sns|msk-kafka-cluster|pubsub|eventbridge)(\/|$)/, 'queue'],
  [/(^|\/)(s3-bucket|cloud-storage)(\/|$)/, 'object-storage'],
  [/(^|\/)(dynamodb-table|docdb)(\/|$)/, 'nosql'],
  [/(^|\/)(opensearch|elasticsearch)(\/|$)/, 'search'],
  [
    /(^|\/)(lambda|ecs\/aws\/\/modules\/service|ec2-instance|autoscaling|cloud-run)(\/|$)/,
    'service',
  ],
];

/** Обвязка: не узлы, и связи сквозь них не проводятся (на группу безопасности ссылаются все). */
const NOISE =
  /^(aws|google|azurerm)_.*(iam|security_group|firewall|network_security|vpc|subnet|route|kms|log_group|logging|cloudwatch|monitoring|acm|certificate|eip|nat_gateway|internet_gateway|key_pair|ecs_cluster|subnet_group|parameter_group|option_group|resource_group|service_account|role|policy|dns|record|zone)/;

/** Имена ресурсов, которые ничего не говорят: вместо них — тег типа. */
const GENERIC_NAMES = new Set(['this', 'main', 'default', 'primary', 'app', 'example', 'a', 'x']);

/** Атрибуты, где лежит человеческое имя ресурса. */
const NAME_ATTRS = [
  'name',
  'identifier',
  'cluster_identifier',
  'function_name',
  'bucket',
  'cluster_id',
  'replication_group_id',
  'domain_name',
  'cluster_name',
  'broker_name',
];

/** Ссылка на ресурс или модуль в выражении: aws_db_instance.main.address, module.db.endpoint. */
const REF =
  /(?<![\w.-])(data\.)?((?:aws|google|azurerm)_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_-]*)(\[[^\]]*\])?(\.[A-Za-z_][\w]*)?|(?<![\w.-])module\.([A-Za-z_][A-Za-z0-9_-]*)/g;

interface Res {
  address: string;
  type: string;
  block: HclBlock;
  /** Адреса ресурсов, на которые он ссылается, и атрибут ссылки (reader_endpoint). */
  refs: { address: string; attr: string }[];
}

/**
 * Читает конфигурацию Terraform: один или несколько файлов .tf и, если есть, .tfvars
 * (их можно просто склеить с .tf — значения переменных сильнее default).
 * Ресурсы облаков становятся узлами, связи — ссылки между ними напрямую или через клей:
 * listener и target group, task definition, event source mapping, интеграции API Gateway.
 */
export function parseTerraform(texts: readonly string[]): TerraformPlan {
  const blocks: HclBlock[] = [];
  const values = new Map<string, string>();
  try {
    for (const t of texts) {
      const body = parseHcl(t);
      blocks.push(...body.blocks);
      // Атрибуты верхнего уровня бывают только в .tfvars: это значения переменных.
      for (const [k, v] of Object.entries(body.attrs)) values.set(`var.${k}`, v);
    }
  } catch (e) {
    if (e instanceof HclError) throw new TerraformError(`HCL не разобрался: ${e.message}`);
    throw e;
  }
  for (const b of blocks) {
    if (
      b.type === 'variable' &&
      b.labels[0] &&
      b.attrs['default'] !== undefined &&
      !values.has(`var.${b.labels[0]}`)
    )
      values.set(`var.${b.labels[0]}`, b.attrs['default']);
    if (b.type === 'locals')
      for (const [k, v] of Object.entries(b.attrs)) values.set(`local.${k}`, v);
  }

  /** Значение выражения, если оно литерал или var./local. с литералом. */
  const literal = (raw: string | undefined, depth = 0): string | null => {
    if (raw === undefined || depth > 4) return null;
    const t = raw.trim();
    if (/^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false') return t;
    if (/^(var|local)\.[\w-]+$/.test(t)) return literal(values.get(t), depth + 1);
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
    if (!m) return null;
    // "${var.project}-api": подставляем литералы, остальное не знаем.
    let ok = true;
    const s = m[1]!.replace(/\$\{\s*([^}]+?)\s*\}/g, (_, e: string) => {
      const v = literal(e, depth + 1);
      if (v === null) ok = false;
      return v ?? '';
    });
    return ok ? s : null;
  };
  const number = (raw: string | undefined): number | null => {
    const v = literal(raw);
    return v !== null && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  };

  // ---------- ресурсы и ссылки ----------
  const res = new Map<string, Res>();
  for (const b of blocks) {
    let type: string;
    let address: string;
    if (b.type === 'resource' && b.labels.length === 2) {
      type = b.labels[0]!;
      address = `${b.labels[0]}.${b.labels[1]}`;
    } else if (b.type === 'module' && b.labels.length === 1) {
      type = 'module';
      address = `module.${b.labels[0]}`;
    } else continue;
    // create = false — модуль выключен (так в примерах показывают, что его можно не создавать).
    if (type === 'module' && literal(b.attrs['create']) === 'false') continue;
    res.set(address, { address, type, block: b, refs: [] });
  }
  // Модуль ECS (terraform-aws-modules/ecs): сервисы лежат картой services = { имя = { … } }.
  for (const r of [...res.values()]) {
    const services = r.type === 'module' ? r.block.attrs['services'] : undefined;
    if (!services?.startsWith('{')) continue;
    for (const [key, raw] of Object.entries(hclObject(services))) {
      if (!raw.startsWith('{')) continue;
      const address = `${r.address}.services.${key}`;
      const block: HclBlock = {
        type: 'service',
        labels: [key],
        ...hclBodyOf(raw),
        text: raw,
        line: r.block.line,
      };
      res.set(address, { address, type: 'ecs-service', block, refs: [] });
    }
  }
  for (const r of res.values()) {
    for (const m of r.block.text.matchAll(REF)) {
      if (m[1]) continue; // data.… — уже существующее, не наше
      const address = m[6] ? `module.${m[6]}` : `${m[2]}.${m[3]}`;
      if (address !== r.address && !r.address.startsWith(`${address}.`) && res.has(address))
        r.refs.push({ address, attr: m[5]?.slice(1) ?? '' });
    }
  }

  const kindOf = (r: Res): NodeKind | null => {
    if (r.type === 'module') {
      const source = literal(r.block.attrs['source']) ?? '';
      return MODULES.find(([re]) => re.test(source))?.[1] ?? null;
    }
    return RESOURCES[r.type]?.kind ?? null;
  };
  const isNode = (r: Res | undefined): boolean => !!r && kindOf(r) !== null;
  const isNoise = (r: Res): boolean => NOISE.test(r.type);

  const notes: string[] = [];
  const nodes = [...res.values()].filter(isNode);
  if (!nodes.length) {
    const modules = [...res.values()].filter((r) => r.type === 'module').length;
    throw new TerraformError(
      res.size
        ? `Среди ${res.size} ресурсов${modules ? ` и модулей` : ''} нет ни сервисов, ни баз, ни очередей — схему не из чего собрать`
        : 'В файлах нет блоков resource и module',
    );
  }

  // ---------- имена узлов ----------
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const r of nodes) {
    const local = r.address.slice(r.address.lastIndexOf('.') + 1);
    // Короткий тег типа: aws_lambda_function → lambda, aws_sqs_queue → sqs.
    const tag =
      r.type === 'module' ? 'module' : r.type.replace(/^(aws|google|azurerm)_/, '').split('_')[0]!;
    const own = NAME_ATTRS.map((a) => literal(r.block.attrs[a])).find((v) => v && v.length <= 60);
    let name = own ?? (GENERIC_NAMES.has(local) ? tag : local);
    // shop-orders — и очередь, и функция: функция станет shop-orders-lambda.
    if (used.has(name)) name = `${name}-${tag}`;
    for (let i = 2; used.has(name); i++) name = `${own ?? local}-${tag}-${i}`;
    used.add(name);
    names.set(r.address, name);
  }

  // ---------- связи ----------
  const edges = new Map<string, Set<string>>(nodes.map((r) => [r.address, new Set<string>()]));
  const link = (from: string, to: string): void => {
    if (from !== to && edges.has(from) && edges.has(to)) edges.get(from)!.add(to);
  };
  const refsOf = (r: Res, pred: (x: Res) => boolean): Res[] =>
    r.refs.map((x) => res.get(x.address)!).filter(pred);
  const typed = (re: RegExp) => (x: Res) => re.test(x.type);
  /** Клей, который проводит связи по своим правилам, — не проводить его ещё и как обычный. */
  const CONNECTORS =
    /^aws_(lb_listener|lb_listener_rule|alb_listener|alb_listener_rule|lb_target_group|alb_target_group|lb_target_group_attachment|autoscaling_attachment|lambda_event_source_mapping|sns_topic_subscription|api_gateway_integration|apigatewayv2_integration|apigatewayv2_route|rds_cluster_instance|appautoscaling_target|appautoscaling_policy)$/;

  // Прямые ссылки и ссылки через один ресурс-клей: ECS → task definition → адрес базы в env.
  // Атрибут ссылки сохраняется: reader_endpoint ведёт к читателям Aurora.
  const reach = new Map<string, { address: string; attr: string }[]>();
  for (const r of nodes) {
    const out: { address: string; attr: string }[] = [];
    for (const x of r.refs) {
      const t = res.get(x.address)!;
      if (isNode(t)) out.push(x);
      else if (!isNoise(t) && !CONNECTORS.test(t.type))
        out.push(...t.refs.filter((y) => isNode(res.get(y.address))));
    }
    reach.set(r.address, out);
    for (const x of out) {
      // Сервис ссылается на свой балансировщик (target group модуля alb) — это балансировщик
      // шлёт в него трафик, а не он зовёт балансировщик.
      const to = res.get(x.address)!;
      if (COMPUTE.has(kindOf(r)!) && ENTRY.has(kindOf(to)!)) link(x.address, r.address);
      else link(r.address, x.address);
    }
  }
  // Ссылки сервис → балансировщик развёрнуты выше; обратная ссылка не нужна.
  for (const r of nodes)
    for (const to of [...edges.get(r.address)!])
      if (COMPUTE.has(kindOf(r)!) && ENTRY.has(kindOf(res.get(to)!)!))
        edges.get(r.address)!.delete(to);

  // ALB → listener → target group ← ECS service, ASG, attachment.
  const targetGroups = [...res.values()].filter(typed(/^aws_(lb|alb)_target_group$/));
  const members = new Map<string, Res[]>(targetGroups.map((tg) => [tg.address, []]));
  for (const r of res.values()) {
    if (/^aws_((lb|alb)_target_group_attachment|autoscaling_attachment)$/.test(r.type)) {
      const tg = refsOf(r, typed(/^aws_(lb|alb)_target_group$/))[0];
      if (tg) members.get(tg.address)!.push(...refsOf(r, isNode));
    } else if (isNode(r)) {
      for (const tg of refsOf(r, typed(/^aws_(lb|alb)_target_group$/)))
        members.get(tg.address)!.push(r);
    }
  }
  const listeners = [...res.values()].filter(typed(/^aws_(lb|alb)_listener(_rule)?$/));
  const lbOf = (l: Res, depth = 0): Res[] => {
    const lbs = refsOf(l, typed(/^aws_(lb|alb|elb)$/));
    if (lbs.length || depth > 2) return lbs;
    return refsOf(l, typed(/^aws_(lb|alb)_listener$/)).flatMap((p) => lbOf(p, depth + 1));
  };
  for (const l of listeners) {
    for (const lb of lbOf(l))
      for (const tg of refsOf(l, typed(/^aws_(lb|alb)_target_group$/)))
        for (const m of members.get(tg.address) ?? []) link(lb.address, m.address);
  }
  // Ссылки на target group напрямую из узла — это «меня обслуживает балансировщик», а не вызов.
  for (const r of nodes)
    for (const tg of refsOf(r, typed(/^aws_(lb|alb)_target_group$/)))
      for (const m of members.get(tg.address) ?? []) edges.get(r.address)?.delete(m.address);

  // Очередь или поток будит Lambda: очередь → функция, функция — воркер.
  const workers = new Set<string>();
  for (const m of [...res.values()].filter(typed(/^aws_lambda_event_source_mapping$/))) {
    const fn = refsOf(m, typed(/^aws_lambda_function$/))[0];
    const src = refsOf(m, (x) => isNode(x) && x !== fn)[0];
    if (fn && src) {
      workers.add(fn.address);
      link(fn.address, src.address); // воркер → очередь; ядро развернёт в очередь → воркер
    }
  }
  // SNS → подписчик.
  for (const s of [...res.values()].filter(typed(/^aws_sns_topic_subscription$/))) {
    const topic = refsOf(s, typed(/^aws_sns_topic$/))[0];
    for (const t of refsOf(s, (x) => isNode(x) && x !== topic)) {
      if (topic && t.type === 'aws_lambda_function') {
        workers.add(t.address);
        link(t.address, topic.address);
      }
    }
  }
  // API Gateway → интеграция → Lambda или балансировщик.
  for (const i of [...res.values()].filter(
    typed(/^aws_(api_gateway_integration|apigatewayv2_integration)$/),
  )) {
    const api = refsOf(i, typed(/^aws_(api_gateway_rest_api|apigatewayv2_api)$/))[0];
    if (!api) continue;
    for (const t of refsOf(i, isNode)) link(api.address, t.address);
    for (const l of refsOf(i, typed(/^aws_(lb|alb)_listener$/)))
      for (const lb of lbOf(l)) link(api.address, lb.address);
  }

  // ---------- реплики ----------
  const replicasOf = (r: Res): number => {
    const kind = r.type === 'module' ? undefined : RESOURCES[r.type];
    let n = 1;
    for (const a of kind?.replicas ?? []) {
      const v = number(r.block.attrs[a]);
      if (v !== null) {
        n = v;
        break;
      }
    }
    // OpenSearch: cluster_config { instance_count = 3 }
    const cc = r.block.blocks.find((b) => b.type === 'cluster_config');
    if (cc) n = number(cc.attrs['instance_count']) ?? n;
    const count = number(r.block.attrs['count']);
    if (count !== null) n *= count;
    else if (
      r.block.attrs['for_each'] !== undefined ||
      (r.block.attrs['count'] !== undefined && count === null)
    )
      notes.push(`${names.get(r.address)}: count или for_each не вычислить — на схеме одна копия`);
    return Math.max(0, Math.round(n));
  };

  // Автомасштабирование ECS: до скольких вырастет.
  const scaling = new Map<string, number>();
  for (const t of [...res.values()].filter(typed(/^aws_appautoscaling_target$/))) {
    const max = number(t.block.attrs['max_capacity']);
    for (const s of refsOf(t, typed(/^aws_ecs_service$/)))
      if (max !== null) scaling.set(s.address, max);
    // resource_id = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  }

  // ASG, который отдан ECS как мощность (capacity provider), — машины под контейнеры, а не сервис.
  const capacity = new Set<string>();
  for (const r of res.values())
    for (const m of r.block.text.matchAll(/auto_scaling_group_arn\s*=\s*([\w.]+)/g)) {
      const ref = /^(module\.[\w-]+|aws_autoscaling_group\.[\w-]+)/.exec(m[1]!)?.[1];
      if (ref && res.has(ref)) capacity.add(ref);
    }

  // ---------- узлы ----------
  const workloads: Workload[] = [];
  const readers: Workload[] = [];
  for (const r of nodes) {
    const name = names.get(r.address)!;
    let kind = kindOf(r)!;
    let why =
      r.type === 'module'
        ? `модуль ${literal(r.block.attrs['source']) ?? ''}`
        : r.type === 'ecs-service'
          ? `services модуля ${r.address.split('.')[1]}`
          : r.type;
    if (workers.has(r.address)) {
      kind = 'worker';
      why += ', запускается событиями очереди';
    }
    // Реплика RDS или Cloud SQL ссылается на основную.
    if (
      kind === 'sql-primary' &&
      (r.block.attrs['replicate_source_db'] !== undefined ||
        r.block.attrs['master_instance_name'] !== undefined)
    ) {
      kind = 'sql-replica';
      why += ', реплика';
    }
    let replicas = replicasOf(r);
    const max = scaling.get(r.address);
    if (max !== undefined && max > replicas)
      notes.push(
        `${name}: автомасштабирование до ${max} задач, на схеме ${replicas} — модель сама не масштабируется`,
      );
    if (r.type === 'aws_lambda_function') why += ', масштабируется сама — ёмкость пресета условна';

    // Aurora: писатель и читатели — разные узлы, читатели — по reader_endpoint.
    if (r.type === 'aws_rds_cluster') {
      const instances = [...res.values()]
        .filter(typed(/^aws_rds_cluster_instance$/))
        .filter((i) => i.refs.some((x) => x.address === r.address))
        .reduce((sum, i) => sum + (number(i.block.attrs['count']) ?? 1), 0);
      const uses = (n: Res) => reach.get(n.address)!.filter((x) => x.address === r.address);
      const readerRefs = nodes.filter((n) => uses(n).some((x) => x.attr === 'reader_endpoint'));
      if (instances > 1 || readerRefs.length) {
        const reader: Workload = {
          ...blank(`${name}-ro`),
          replicas: Math.max(1, instances - 1),
          role: {
            role: { kind: 'sql-replica' },
            why: 'aws_rds_cluster, читатели по reader_endpoint',
          },
        };
        readers.push(reader);
        for (const n of readerRefs) {
          const writes = uses(n).some((x) => x.attr !== 'reader_endpoint');
          edges.get(n.address)!.add(`reader:${reader.name}`);
          if (!writes) edges.get(n.address)!.delete(r.address);
        }
        replicas = 1;
      }
    }

    workloads.push({
      ...blank(name),
      replicas,
      published: kind === 'cdn' || kind === 'load-balancer' || kind === 'api-gateway',
      role: capacity.has(r.address)
        ? { role: { skip: 'infra' }, why: `${why}: машины для контейнеров ECS, а не сервис` }
        : { role: { kind }, why },
    });
  }
  workloads.push(...readers);
  const byAddress = new Map(nodes.map((r) => [r.address, names.get(r.address)!]));
  for (const w of workloads) {
    const address = [...byAddress].find(([, n]) => n === w.name)?.[0];
    if (!address) continue;
    w.dependsOn = [...edges.get(address)!].map((to) => ({
      name: to.startsWith('reader:') ? to.slice(7) : byAddress.get(to)!,
      completed: false,
    }));
  }

  const projects = blocks
    .filter(
      (b) =>
        b.type === 'variable' &&
        /^(project|project_name|app|app_name|name|service_name)$/.test(b.labels[0] ?? ''),
    )
    .map((b) => literal(b.attrs['default']))
    .find(Boolean);
  return { ...(projects ? { name: projects } : {}), workloads, notes };
}

const COMPUTE: ReadonlySet<NodeKind> = new Set(['service', 'worker']);
const ENTRY: ReadonlySet<NodeKind> = new Set(['cdn', 'load-balancer', 'api-gateway']);

/** Объект HCL { a = 1, b = { … } }: ключ → исходный текст значения. */
function hclObject(raw: string): Record<string, string> {
  return hclBodyOf(raw).attrs;
}

function hclBodyOf(raw: string): { attrs: Record<string, string>; blocks: HclBlock[] } {
  try {
    // В объекте пары могут разделяться запятыми — для разбора тела они лишние.
    return parseHcl(
      raw.slice(raw.indexOf('{') + 1, raw.lastIndexOf('}')).replace(/,(\s*\n)/g, '$1'),
    );
  } catch {
    return { attrs: {}, blocks: [] };
  }
}

function blank(name: string): Workload {
  return {
    name,
    command: '',
    env: {},
    dependsOn: [],
    links: [],
    hostnames: [],
    replicas: 1,
    ports: [],
    published: false,
    labels: {},
    mounts: [],
  };
}

/** Похоже на Terraform: блоки resource, module, provider или terraform верхнего уровня. */
export function looksLikeTerraform(text: string): boolean {
  return /^\s*(resource|module|provider|terraform|variable)\s+("[^"]*"\s*)*\{/m.test(text);
}
