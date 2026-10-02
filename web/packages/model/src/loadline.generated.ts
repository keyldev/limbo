/* Сгенерировано из spec/loadline.schema.json. Не править руками: pnpm gen:model */

export type Id = string;
export type NodeKind =
  | "client"
  | "cdn"
  | "load-balancer"
  | "api-gateway"
  | "service"
  | "worker"
  | "cache"
  | "sql-primary"
  | "sql-replica"
  | "nosql"
  | "queue"
  | "object-storage"
  | "search";
/**
 * Ссылка на порт узла: <nodeId>:in или <nodeId>:out
 */
export type PortRef = string;

/**
 * Схема Loadline: компоненты, связи и входящий трафик. Формат открытый и версионированный.
 */
export interface LoadlineDocument {
  format: "loadline";
  version: 1;
  meta?: Meta;
  traffic: Traffic;
  /**
   * @maxItems 500
   */
  nodes: Node[];
  /**
   * @maxItems 2000
   */
  edges: Edge[];
}
export interface Meta {
  title?: string;
  description?: string;
  createdAt?: string;
}
export interface Traffic {
  /**
   * Входящий поток, запросов в секунду
   */
  rps: number;
  /**
   * Доля чтений в потоке
   */
  readShare?: number;
  /**
   * Множитель всплеска (кнопка Spike ×4)
   */
  spike?: number;
}
export interface Node {
  id: Id;
  kind: NodeKind;
  label?: string;
  /**
   * Идентификатор пресета из spec/presets
   */
  preset?: string;
  pos: Position;
  params?: NodeParams;
}
export interface Position {
  x: number;
  y: number;
}
export interface NodeParams {
  replicas?: number;
  /**
   * μ — ёмкость одной реплики, rps. Если не задана, берётся из пресета
   */
  capacityRps?: number;
  /**
   * t₀ — время обработки без очереди, мс
   */
  baseLatencyMs?: number;
  /**
   * Доля попаданий для cache и cdn
   */
  hitRatio?: number;
  /**
   * Стоимость одной реплики в месяц, USD
   */
  costPerReplicaUsd?: number;
  /**
   * Тумблер «Simulate outage»
   */
  outage?: boolean;
}
export interface Edge {
  id: Id;
  from: PortRef;
  to: PortRef;
  mode?: "sequential" | "parallel";
  /**
   * Связь несёт только чтения или только записи. Без поля — все запросы
   */
  only?: "read" | "write";
}
