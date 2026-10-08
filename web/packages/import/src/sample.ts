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
