# Импорт из конфигов

Кнопка «Импорт» собирает схему из `docker-compose.yml`, манифестов Kubernetes или конфигурации Terraform и, если есть, `Caddyfile` или `nginx.conf`. Файлы можно вставить текстом, выбрать или перетащить на доску; несколько манифестов склеиваются в один поток через `---`, несколько `.tf` и `.tfvars` — подряд. Всё разбирается в браузере, на сервер ничего не уходит. Код: `web/packages/import`.

Импорт угадывает, а не знает. Поэтому до открытия видно, во что превратился каждый контейнер и почему, а спорные догадки о связях выписаны отдельно. Ёмкости и задержки — пресеты по умолчанию, не цифры вашей системы.

## Тип узла

По порядку, первое совпадение побеждает:

1. **Одноразовая задача** — в имени есть `migrate`, `seed`, `init`, `setup`, `bootstrap`, или другой сервис ждёт её через `condition: service_completed_successfully`. Узла нет, связи проводятся сквозь неё: `api → migrate → postgres` становится `api → postgres`.
2. **Образ.** Слова из имени образа без реестра и тега: `postgres`, `mysql`, `mssql` — SQL; `redis`, `valkey`, `memcached` — кэш; `mongo`, `cassandra`, `clickhouse` — документная БД; `rabbitmq`, `kafka`, `nats` — очередь; `minio` — хранилище; `elasticsearch`, `meilisearch` — поиск; `nginx`, `caddy`, `traefik`, `haproxy` — балансировщик; `kong`, `krakend` — API-шлюз; `varnish` — CDN. Полный список — `src/classify.ts`.
3. **Порт**, если образ свой: `5432`, `3306` — SQL; `27017`, `9042` — документная БД; `6379`, `11211` — кэш; `5672`, `9092`, `4222` — очередь; `9200` — поиск. В Kubernetes считается и имя порта (`mongo`, `mysql`). Порты берутся из `ports` и `expose` в compose и из `containerPort` основного контейнера в k8s.
4. **Имя сервиса**: `worker`, `consumer`, `celery`, `scheduler` — воркер; `db` — SQL; `cache` — кэш; `queue`, `broker` — очередь. Если имя говорит «база, кэш или очередь», а контейнер слушает HTTP-порт (`80`, `8080`, `3000` и т. п.), это сервис, который с ней работает: `queue-master` на порту 80 — не очередь.
5. **Команда:** `celery … worker`, `sidekiq` и похожие делают из сервиса воркер, даже если образ общий с API.
6. Иначе — **сервис**.

SQL-база с `replica`, `standby`, `read` в имени или с `*_REPLICATION_MODE=slave` у образов bitnami — реплика.

Не попадают на схему:

- **обвязка** — мониторинг, логи, админки, почта для разработки (`prometheus`, `grafana`, `jaeger`, `pgadmin`, `mailpit`, `zookeeper` и т. п.), её связи выбрасываются;
- **пулеры** соединений (`pgbouncer`, `proxysql`) — связи проводятся сквозь них;
- сервисы с `replicas: 0`.

`deploy.replicas` или `scale` становится числом реплик узла.

## Связи

Связь `A → B` значит «A зовёт B». Откуда берутся:

- `depends_on` и `links`;
- имя другого контейнера в значениях переменных окружения и в команде: `Host=postgres;…`, `redis://redis:6379`. Совпадение ищется по имени сервиса, `container_name`, `hostname` и сетевым алиасам, целым словом. `${DB_HOST:-postgres}` подставляется значением по умолчанию;
- метки `traefik.enable=true` и `traefik.http.routers.*` — связь от traefik;
- апстримы прокси: `reverse_proxy` и `to` в Caddyfile, `proxy_pass`, `fastcgi_pass` и `upstream { server … }` в nginx. Конфиг относится к контейнеру, который его монтирует, а если такого нет — к балансировщику того же сорта. Апстрим, которого нет в compose, становится сервисом, а внешние домены пропускаются.

Потом связи приводятся к модели:

- **Из данных никто не зовёт.** Исходящие связи баз, кэшей, очередей, хранилищ и поиска убираются: в compose это обычно ожидание старта, а не запросы.
- **Против пути запроса не зовут.** Порядок: клиенты → CDN → балансировщик → шлюз → сервисы и воркеры → кэш и очередь → базы. Связь назад (сервис зовёт балансировщик) убирается.
- **Очередь отдаёт задачи воркеру.** Воркер, который зависит от очереди, — её потребитель: связь разворачивается в `очередь → воркер`. Связь от сервиса в очередь — параллельная, отправитель не ждёт.
- **Кэш перед базой.** Если сервис ходит ровно в один кэш и в базу, кэш встаёт перед базой: `api → redis → postgres`, в базу доходят только промахи. Так в модели выглядит cache-aside. У воркеров так не делается: им redis обычно служит брокером задач (celery, sidekiq, rq).
- **Реплика для чтений.** Сервис, который ходит и в основную базу, и в реплику, читает из реплики и пишет в основную.
- **Циклы рвутся.** Движок не считает циклы, поэтому обратная связь, найденная обходом от клиентов, убирается.

## Вход

Клиенты приходят в балансировщики, шлюзы и CDN, в которые никто не ходит. Если таких нет — в сервисы с опубликованными `ports` (в Kubernetes — за Service типа `LoadBalancer` или `NodePort`), иначе — в сервисы без входящих связей. Трафик по умолчанию — 1000 rps, 80% чтений.

Если сервис ходит и в кэш, и в основную базу, и в реплику, кэш встаёт на пути чтений: `api → redis → реплика` для чтений и `api → основная` для записей.

## Kubernetes

Подходит всё, что выводит `kubectl get … -o yaml` (в том числе `kind: List`), `helm template` и `kustomize build`, или папка с манифестами. Манифест узнаётся по `apiVersion` и `kind` на верхнем уровне. Код: `src/k8s.ts`.

**Узлы** — ворклоады: `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, голый `Pod`, `Rollout` из Argo Rollouts, `DeploymentConfig` из OpenShift. Поды и ReplicaSet с `ownerReferences` пропускаются: это копии ворклоадов из `kubectl get all`. Тип угадывается по образу основного контейнера по тем же правилам, что в compose. Основной — контейнер с именем ворклоада, иначе первый, кто не спутник: `istio-proxy`, `linkerd-proxy`, `cloud-sql-proxy`, `vault-agent`, экспортеры метрик и сборщики логов.

- `Job` и `CronJob` — одноразовые задачи, узла нет.
- **Реплики** — `spec.replicas`, а если их нет — `minReplicas` из `HorizontalPodAutoscaler` или `minReplicaCount` из `ScaledObject` KEDA. Модель сама не масштабируется, поэтому до скольких вырастет HPA, выписывается отдельно: поставьте это число руками, чтобы проверить пик.
- **Базы и очереди от операторов** узнаются без ворклоадов: `Cluster` CloudNativePG (основная за `<имя>-rw` и реплики для чтения за `<имя>-ro`), `postgresql` Zalando (`<имя>` и `<имя>-repl`), `Kafka` Strimzi (`<имя>-kafka-bootstrap`), `RabbitmqCluster`, `MongoDBCommunity`, `Elasticsearch` из ECK.
- Ворклоад, который KEDA масштабирует по очереди (`rabbitmq`, `kafka`, `aws-sqs-queue` и т. п.), — воркер, а адрес из триггера — его очередь.

**Адреса.** Ворклоад виден под именами всех `Service`, чей `selector` совпадает с метками пода в том же неймспейсе: `api`, `api.shop`, `api.shop.svc`, `api.shop.svc.cluster.local`. Если один Service выбирает несколько ворклоадов (стабильная версия и канарейка), связь идёт в каждый. `ExternalName` ведёт наружу и пропускается. Если в манифестах нет ни одного Service, адресом считается имя ворклоада.

**Связи** ищутся по адресам так же, как в compose, только текстов больше: `env` всех контейнеров, `valueFrom` и `envFrom` из `ConfigMap` и `Secret` (`data` раскодируется из base64), команды init-контейнеров и спутников, содержимое примонтированных ConfigMap и Secret — `application.yaml`, `appsettings.json` и т. п.

**Вход.**

- `Ingress` — балансировщик `ingress-<класс>` по `ingressClassName` или аннотации `kubernetes.io/ingress.class`, связи в бэкенды всех правил;
- `IngressRoute` traefik — балансировщик `traefik`;
- `HTTPRoute` и `GRPCRoute` Gateway API — балансировщик с именем шлюза из `parentRefs`;
- `VirtualService` Istio, привязанный к шлюзу, — `istio-ingressgateway`;
- `nginx.conf` или `Caddyfile` внутри `ConfigMap` разбирается как конфиг прокси того ворклоада, который этот ConfigMap монтирует.

## Terraform

Файлы `.tf` и `.tfvars` из одной папки (корневой модуль). Код: `src/terraform.ts`, HCL разбирается своим кодом без зависимостей (`src/hcl.ts`). Выражения не вычисляются: из атрибутов берутся только литералы, `var.*` со значением из `.tfvars` или `default`, `local.*` и строки вида `"${var.project}-api"`.

**Узлы** — ресурсы облаков, которые принимают или хранят трафик:

| Тип узла | AWS | Google Cloud | Azure |
| --- | --- | --- | --- |
| CDN | `aws_cloudfront_distribution` | — | `azurerm_cdn_frontdoor_profile`, `azurerm_cdn_profile` |
| Балансировщик | `aws_lb`, `aws_alb`, `aws_elb` | `google_compute_url_map` | `azurerm_application_gateway`, `azurerm_lb` |
| API-шлюз | `aws_api_gateway_rest_api`, `aws_apigatewayv2_api` | `google_api_gateway_gateway` | `azurerm_api_management` |
| Сервис | `aws_ecs_service`, `aws_lambda_function`, `aws_instance`, `aws_autoscaling_group`, App Runner | Cloud Run, Cloud Functions, `google_compute_instance(_group_manager)` | Web App, Function App, Container App, VM и VMSS |
| SQL | `aws_db_instance`, `aws_rds_cluster` | `google_sql_database_instance`, Spanner, AlloyDB | PostgreSQL, MySQL, MSSQL |
| Кэш | ElastiCache, MemoryDB | Memorystore | `azurerm_redis_cache` |
| Документная БД | DynamoDB, DocumentDB, Keyspaces | Firestore, Bigtable | Cosmos DB |
| Очередь | SQS, SNS, MSK, Amazon MQ, Kinesis | Pub/Sub | Service Bus, Event Hubs |
| Хранилище | `aws_s3_bucket` | `google_storage_bucket` | `azurerm_storage_account` |
| Поиск | OpenSearch | — | `azurerm_search_service` |

Полный список — `RESOURCES` в `src/terraform.ts`. Модули из реестра узнаются по `source`: `terraform-aws-modules/rds/aws` — SQL, `…/alb/aws` — балансировщик, `…/sqs/aws` — очередь и т. п. У модуля `terraform-aws-modules/ecs` каждый сервис из карты `services` — свой узел. Модули с `create = false` пропускаются.

**Имя узла** — из `name`, `identifier`, `function_name`, `bucket` и похожих, иначе имя ресурса. Если имена совпали (очередь и функция `shop-orders`), к второму добавляется тег типа: `shop-orders-lambda`.

**Реплики:** `desired_count`, `desired_capacity`, `num_cache_clusters`, `instance_count` и т. п., умноженные на `count`. Для `for_each` и невычислимого `count` — одна копия и заметка. Потолок `aws_appautoscaling_target` выписывается так же, как HPA.

**Связи** — ссылки между ресурсами: `aws_db_instance.main.address` в переменных Lambda — связь из функции в базу. Ссылки проходят и через один ресурс-посредник: ECS-сервис → `aws_ecs_task_definition` → адрес базы в `environment`. Сквозь IAM, группы безопасности, сети, ключи, логи и DNS связи не проводятся: на них ссылается всё. Особые посредники:

- `aws_lb_listener` и `aws_lb_target_group`: балансировщик шлёт в то, что входит в группу, — ECS-сервис с `load_balancer`, ASG через `aws_autoscaling_attachment`, цель `aws_lb_target_group_attachment`. Если сервис сам ссылается на балансировщик (`module.alb.target_groups[…]`), связь разворачивается: балансировщик → сервис;
- `aws_lambda_event_source_mapping` и `aws_sns_topic_subscription`: очередь будит функцию, функция — воркер;
- `aws_api_gateway_integration` и `aws_apigatewayv2_integration`: шлюз → функция или балансировщик;
- Aurora: если кто-то читает `reader_endpoint` или у кластера больше одного `aws_rds_cluster_instance`, читатели — отдельный узел-реплика, а чтения идут в него;
- `replicate_source_db` у `aws_db_instance` и `master_instance_name` у Cloud SQL — реплика;
- ASG, отданный ECS как мощность (`auto_scaling_group_arn`), — машины под контейнеры, не сервис.

`data`-источники — то, что уже существует вне конфигурации, — на схему не попадают.

## На чём проверено

- [Online Boutique](https://github.com/GoogleCloudPlatform/microservices-demo) (`release/kubernetes-manifests.yaml`): 11 сервисов и все 16 связей между ними, вход через `frontend`, генератор нагрузки пропущен.
- [example-voting-app](https://github.com/dockersamples/example-voting-app) (compose): `vote → redis`, `worker → redis`, `worker → db`, `result → db`, задача `seed` пропущена.
- [learn-terraform-aws-asg](https://github.com/hashicorp-education/learn-terraform-aws-asg): ALB → ASG через `aws_autoscaling_attachment`.
- [terraform-aws-ecs](https://github.com/terraform-aws-modules/terraform-aws-ecs) (`examples/complete`): сервис из карты `services` за модулем ALB, ASG-мощность и выключенные модули пропущены.
- [Sock Shop](https://github.com/microservices-demo/microservices-demo) (`deploy/kubernetes/complete-demo.yaml`): типы всех 14 ворклоадов, `user-db` узнаётся как MongoDB по порту. Связей почти нет: адреса соседей зашиты в образы, в манифестах их не найти — их придётся провести на доске.

## Чего нет

- Terraform: выражения не вычисляются (функции, условия, `for`), вложенные модули из своих папок не читаются — вставьте их файлы вместе с корневыми; Kubernetes-ресурсы из провайдера `kubernetes` и Helm-релизы не разбираются.
- Kubernetes: `NetworkPolicy` и сетка сервисов (кроме входа Istio) не читаются; Helm-чарт нужно сначала отрендерить `helm template`; несколько кластеров или неймспейсов с одинаковыми именами различаются суффиксом `.<неймспейс>`.
- `extends`, `include` и `.env`: переменные без значения по умолчанию подставляются пустыми.
- Редкого YAML: сложные ключи `?`, несколько документов в compose-файле. YAML разбирается своим кодом без зависимостей (`src/yaml.ts`), в объёме, которого хватает compose и манифестам.
- Реальных цифр: импорт только рисует схему, ёмкости правятся в инспекторе.
