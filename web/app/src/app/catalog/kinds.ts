import type { NodeKind } from '@loadline/model';
import type { Routing } from '@loadline/engine';

export type KindGroup = 'Вход' | 'Вычисления' | 'Данные';

export interface KindInfo {
  kind: NodeKind;
  /** Название в палитре и инспекторе. */
  label: string;
  /** Основа имени нового узла: service, service-2, … */
  slug: string;
  group: KindGroup;
  /** Пресет по умолчанию из spec/presets/default.json. */
  preset: string;
}

/** Каталог компонентов палитры. Порядок — порядок в палитре. */
export const KINDS: readonly KindInfo[] = [
  { kind: 'client', label: 'Клиенты', slug: 'clients', group: 'Вход', preset: 'client.default' },
  { kind: 'cdn', label: 'CDN', slug: 'cdn', group: 'Вход', preset: 'cdn.default' },
  {
    kind: 'load-balancer',
    label: 'Балансировщик',
    slug: 'lb',
    group: 'Вход',
    preset: 'lb.default',
  },
  {
    kind: 'api-gateway',
    label: 'API-шлюз',
    slug: 'gateway',
    group: 'Вход',
    preset: 'gateway.default',
  },
  {
    kind: 'service',
    label: 'Сервис',
    slug: 'service',
    group: 'Вычисления',
    preset: 'service.small',
  },
  { kind: 'worker', label: 'Воркер', slug: 'worker', group: 'Вычисления', preset: 'worker.small' },
  { kind: 'cache', label: 'Кэш', slug: 'cache', group: 'Данные', preset: 'cache.redis-small' },
  {
    kind: 'sql-primary',
    label: 'SQL, основная',
    slug: 'sql',
    group: 'Данные',
    preset: 'sql.primary-medium',
  },
  {
    kind: 'sql-replica',
    label: 'SQL, реплика',
    slug: 'sql-replica',
    group: 'Данные',
    preset: 'sql.replica-medium',
  },
  {
    kind: 'nosql',
    label: 'Документная БД',
    slug: 'nosql',
    group: 'Данные',
    preset: 'nosql.default',
  },
  { kind: 'queue', label: 'Очередь', slug: 'queue', group: 'Данные', preset: 'queue.default' },
  {
    kind: 'object-storage',
    label: 'Объектное хранилище',
    slug: 'bucket',
    group: 'Данные',
    preset: 'storage.object',
  },
  {
    kind: 'search',
    label: 'Поисковый индекс',
    slug: 'search',
    group: 'Данные',
    preset: 'search.default',
  },
];

export const KIND_GROUPS: readonly KindGroup[] = ['Вход', 'Вычисления', 'Данные'];

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

export function kindInfo(kind: NodeKind): KindInfo {
  return BY_KIND.get(kind)!;
}

/** Как узел передаёт запросы дальше — одной фразой для инспектора. */
export const ROUTING_TEXT: Record<Routing | 'source', string> = {
  source: 'Отправляет запросы в систему и делит их поровну между своими связями.',
  split: 'Отправляет каждый запрос в одну из связей: поток делится поровну.',
  fanout: 'На каждый запрос зовёт все свои связи, одну за другой.',
  async: 'Отдаёт каждое сообщение всем потребителям. Отправитель их не ждёт.',
};
