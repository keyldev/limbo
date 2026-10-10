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
