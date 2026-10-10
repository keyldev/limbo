import type { Classified } from './classify.js';

/**
 * Что-то запущенное — сервис compose или ворклоад Kubernetes — в том виде, в каком его
 * читает importConfigs: только то, что нужно для схемы.
 */
export interface Workload {
  name: string;
  image?: string;
  /** command и entrypoint одной строкой. */
  command: string;
  env: Record<string, string>;
  dependsOn: { name: string; completed: boolean }[];
  links: string[];
  /** Под какими именами он виден в сети: имя сервиса, container_name, алиасы, DNS сервисов k8s. */
  hostnames: string[];
  replicas: number;
  /** Порты, которые слушает: номера и имена. По ним узнаётся база в своём образе. */
  ports: string[];
  /** Опубликован наружу: кандидат во вход системы. */
  published: boolean;
  labels: Record<string, string>;
  /** Что примонтировано с хоста: ./Caddyfile:/etc/caddy/Caddyfile → ./Caddyfile. */
  mounts: string[];
  /** Ещё тексты, где ищутся адреса соседей: init-контейнеры, примонтированные ConfigMap. */
  refs?: string[];
  /** Тип известен без угадывания: Job, оператор базы. */
  role?: Classified;
  /** Откуда взят, если это не compose: Deployment, StatefulSet. Пишется перед «почему». */
  origin?: string;
}
