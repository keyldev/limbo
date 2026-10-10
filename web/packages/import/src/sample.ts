/** Пример для кнопки «Вставить пример»: обычный стек — прокси, API, воркер, кэш, база, очередь. */
export const SAMPLE_COMPOSE = `services:
  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80"]
    depends_on: [api]

  api:
    build: ./api
    deploy:
      replicas: 2
    environment:
      DATABASE_URL: postgres://app:secret@postgres:5432/app
      REDIS_URL: redis://redis:6379/0
      AMQP_URL: amqp://rabbitmq:5672
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_started

  worker:
    build: ./api
    command: celery -A app worker
    environment:
      DATABASE_URL: postgres://app:secret@postgres:5432/app
      AMQP_URL: amqp://rabbitmq:5672
    depends_on: [rabbitmq, postgres]

  migrate:
    build: ./api
    command: alembic upgrade head
    restart: "no"
    depends_on: [postgres]

  redis:
    image: redis:7-alpine

  postgres:
    image: postgres:17-alpine
    volumes: [pg-data:/var/lib/postgresql/data]

  rabbitmq:
    image: rabbitmq:4-management

  grafana:
    image: grafana/grafana
    ports: ["3000:3000"]

volumes:
  pg-data:
`;

/**
 * Пример манифестов Kubernetes: магазин за ingress-nginx. Видно всё, что умеет импорт:
 * HPA, ConfigMap с адресами, база от CloudNativePG с репликами для чтения, воркер,
 * которого KEDA масштабирует по очереди, Job миграций и sidecar с метриками.
 */
export const SAMPLE_KUBERNETES = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  namespace: shop
spec:
  ingressClassName: nginx
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service: { name: api, port: { number: 80 } }
          - path: /
            pathType: Prefix
            backend:
              service: { name: web, port: { number: 80 } }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/shop-web:2.3.1
          env:
            - name: API_URL
              value: http://api.shop.svc.cluster.local
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/shop-api:2.3.1
          envFrom:
            - configMapRef: { name: api-config }
        - name: metrics
          image: prom/statsd-exporter
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
  namespace: shop
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 3
  maxReplicas: 12
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
  namespace: shop
data:
  DB_WRITE: postgres://shop@shop-db-rw:5432/shop
  DB_READ: postgres://shop@shop-db-ro:5432/shop
  REDIS_URL: redis://redis:6379/0
  AMQP_URL: amqp://orders-mq:5672
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-worker
  namespace: shop
spec:
  selector:
    matchLabels: { app: order-worker }
  template:
    metadata:
      labels: { app: order-worker }
    spec:
      containers:
        - name: order-worker
          image: ghcr.io/acme/shop-api:2.3.1
          args: [orders, consume]
          env:
            - name: DATABASE_URL
              value: postgres://shop@shop-db-rw:5432/shop
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-worker
  namespace: shop
spec:
  scaleTargetRef: { name: order-worker }
  maxReplicaCount: 20
  triggers:
    - type: rabbitmq
      metadata:
        host: amqp://orders-mq:5672
        queueName: orders
---
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
  namespace: shop
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/acme/shop-api:2.3.1
          args: [migrate]
          envFrom:
            - configMapRef: { name: api-config }
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: shop
spec:
  serviceName: redis
  selector:
    matchLabels: { app: redis }
  template:
    metadata:
      labels: { app: redis }
    spec:
      containers:
        - name: redis
          image: redis:7.4-alpine
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: shop-db
  namespace: shop
spec:
  instances: 3
  storage: { size: 20Gi }
---
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: orders-mq
  namespace: shop
spec:
  replicas: 3
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: shop }
spec:
  selector: { app: web }
  ports: [{ port: 80, targetPort: 3000 }]
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: shop }
spec:
  selector: { app: api }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: v1
kind: Service
metadata: { name: redis, namespace: shop }
spec:
  selector: { app: redis }
  ports: [{ port: 6379 }]
`;

/**
 * Пример Terraform: магазин на AWS. CloudFront перед ALB и S3, API на ECS за ALB,
 * Aurora с читателями, ElastiCache, заказы через SQS в Lambda.
 */
export const SAMPLE_TERRAFORM = `variable "project" {
  default = "shop"
}

variable "api_tasks" {
  type    = number
  default = 3
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled = true
  origin {
    origin_id   = "api"
    domain_name = aws_lb.api.dns_name
  }
  origin {
    origin_id   = "static"
    domain_name = aws_s3_bucket.static.bucket_regional_domain_name
  }
}

resource "aws_s3_bucket" "static" {
  bucket = "\${var.project}-static"
}

resource "aws_lb" "api" {
  name               = "\${var.project}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "api" {
  port     = 8080
  protocol = "HTTP"
  vpc_id   = var.vpc_id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family = "\${var.project}-api"
  container_definitions = jsonencode([{
    name  = "api"
    image = "ghcr.io/acme/shop-api:2.3.1"
    environment = [
      { name = "DB_WRITE", value = aws_rds_cluster.db.endpoint },
      { name = "DB_READ", value = aws_rds_cluster.db.reader_endpoint },
      { name = "REDIS_HOST", value = aws_elasticache_replication_group.cache.primary_endpoint_address },
      { name = "ORDERS_QUEUE", value = aws_sqs_queue.orders.url },
    ]
  }])
}

resource "aws_ecs_service" "api" {
  name            = "\${var.project}-api"
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_tasks
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/\${aws_ecs_cluster.main.name}/\${aws_ecs_service.api.name}"
  min_capacity       = 3
  max_capacity       = 12
}

resource "aws_rds_cluster" "db" {
  cluster_identifier = "\${var.project}-db"
  engine             = "aurora-postgresql"
}

resource "aws_rds_cluster_instance" "db" {
  count              = 3
  cluster_identifier = aws_rds_cluster.db.id
  instance_class     = "db.r6g.large"
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id = "\${var.project}-cache"
  engine               = "redis"
  num_cache_clusters   = 2
}

resource "aws_sqs_queue" "orders" {
  name = "\${var.project}-orders"
}

resource "aws_lambda_function" "orders" {
  function_name = "\${var.project}-orders"
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  environment {
    variables = {
      DATABASE_URL = aws_rds_cluster.db.endpoint
    }
  }
}

resource "aws_lambda_event_source_mapping" "orders" {
  event_source_arn = aws_sqs_queue.orders.arn
  function_name    = aws_lambda_function.orders.arn
  batch_size       = 10
}
`;
