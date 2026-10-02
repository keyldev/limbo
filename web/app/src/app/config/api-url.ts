/** Подставляется при сборке: ng build --define LOADLINE_API_URL="'https://api.example.com'". */
declare const LOADLINE_API_URL: string | undefined;

/**
 * Адрес API. Пусто — тот же origin: в разработке /api проксирует Angular (proxy.conf.json).
 * В проде фронт и API на разных доменах (ADR 0004), адрес задаёт workflow деплоя.
 */
export const API_BASE_URL: string = typeof LOADLINE_API_URL === 'string' ? LOADLINE_API_URL : '';
