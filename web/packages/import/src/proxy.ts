/** Конфиг прокси: из него берём только то, куда он проксирует. */
export interface ProxyConfig {
  /** ingress — вход из манифестов Kubernetes: Ingress, HTTPRoute, VirtualService. */
  flavor: 'caddy' | 'nginx' | 'ingress';
  /** Хосты апстримов в порядке появления, без повторов. */
  upstreams: string[];
}

/**
 * Хост из адреса апстрима: http://api:8080/path → api, h2c://grpc:50051 → grpc.
 * Плейсхолдеры ({$UPSTREAM}, $backend) и unix-сокеты пропускаем — их не разрешить.
 */
export function hostOf(target: string): string | null {
  let t = target.trim().replace(/^[a-z0-9+]+:\/\//i, '');
  if (!t || /[{}$]/.test(t) || t.startsWith('unix') || t.startsWith('/')) return null;
  t = t.split('/')[0]!;
  // [::1]:8080
  if (t.startsWith('[')) return t.slice(1, t.indexOf(']')) || null;
  return t.split(':')[0] || null;
}

function uniq(hosts: (string | null)[]): string[] {
  return [...new Set(hosts.filter((h): h is string => !!h))];
}

/** Убирает комментарии: # до конца строки, если # не внутри слова. */
function stripComments(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trim());
}

/** Caddyfile: reverse_proxy <targets…>, to <targets…> внутри блока reverse_proxy, php_fastcgi. */
export function parseCaddyfile(text: string): ProxyConfig {
  const hosts: (string | null)[] = [];
  let depth = 0;
  let proxyDepth = -1;
  for (const line of stripComments(text)) {
    const words = line.split(/\s+/).filter(Boolean);
    const [head, ...rest] = words;
    const args = rest.filter((w) => w !== '{' && !w.startsWith('@') && !w.startsWith('*'));
    if (head === 'reverse_proxy' || head === 'php_fastcgi') {
      // reverse_proxy /api/* api:8080 — первый аргумент может быть путём-матчером
      hosts.push(...args.filter((w) => !w.startsWith('/')).map(hostOf));
      if (line.endsWith('{')) proxyDepth = depth;
    } else if (head === 'to' && proxyDepth >= 0) {
      hosts.push(...args.map(hostOf));
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (proxyDepth >= 0 && depth <= proxyDepth) proxyDepth = -1;
  }
  return { flavor: 'caddy', upstreams: uniq(hosts) };
}

/** nginx.conf: proxy_pass, fastcgi_pass и родня; имя upstream раскрывается в его server. */
export function parseNginx(text: string): ProxyConfig {
  const body = stripComments(text).join('\n');
  const upstreams = new Map<string, string[]>();
  for (const m of body.matchAll(/upstream\s+([\w.-]+)\s*\{([^}]*)\}/g)) {
    const servers = [...m[2]!.matchAll(/(?:^|[\s;])server\s+([^\s;]+)/g)].map((s) => s[1]!);
    upstreams.set(m[1]!, servers);
  }
  const hosts: (string | null)[] = [];
  for (const m of body.matchAll(/\b(?:proxy|fastcgi|grpc|uwsgi|scgi)_pass\s+([^;\s]+)\s*;/g)) {
    const host = hostOf(m[1]!);
    const group = host ? upstreams.get(host) : undefined;
    hosts.push(...(group ? group.map(hostOf) : [host]));
  }
  return { flavor: 'nginx', upstreams: uniq(hosts) };
}
