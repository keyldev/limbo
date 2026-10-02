import type { LoadlineDocument } from '@loadline/model';

/**
 * Клиент API v1.
 *
 * Пока сервер не собран, контракт описан здесь вручную и повторяет
 * server/src/Loadline.Api/Endpoints/DiagramEndpoints.cs. После первой сборки .NET
 * запустите `pnpm gen:api`: появится src/openapi.generated.ts, и типы ниже
 * нужно заменить на сгенерированные (задача недели 3).
 */

export interface CreateDiagramResponse {
  slug: string;
  /** Показывается один раз. Храните локально рядом со схемой. */
  editToken: string;
  version: number;
}

export interface DiagramResponse {
  slug: string;
  version: number;
  doc: LoadlineDocument;
  createdAt: string;
  updatedAt: string;
}

/** Ошибка в формате RFC 9457 (ProblemDetails). */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export interface LoadlineApiOptions {
  /** Например, https://api.loadline.dev. По умолчанию — тот же origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class LoadlineApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LoadlineApiOptions = {}) {
    this.base = (options.baseUrl ?? '').replace(/\/$/, '') + '/api/v1';
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  createDiagram(doc: LoadlineDocument): Promise<CreateDiagramResponse> {
    return this.request('POST', '/diagrams', { body: doc });
  }

  getDiagram(slug: string): Promise<DiagramResponse> {
    return this.request('GET', `/diagrams/${encodeURIComponent(slug)}`);
  }

  updateDiagram(slug: string, doc: LoadlineDocument, editToken: string, version: number): Promise<DiagramResponse> {
    return this.request('PUT', `/diagrams/${encodeURIComponent(slug)}`, {
      body: doc,
      headers: { 'X-Edit-Token': editToken, 'If-Match': `"${version}"` },
    });
  }

  deleteDiagram(slug: string, editToken: string): Promise<void> {
    return this.request('DELETE', `/diagrams/${encodeURIComponent(slug)}`, {
      headers: { 'X-Edit-Token': editToken },
    });
  }

  forkDiagram(slug: string): Promise<CreateDiagramResponse> {
    return this.request('POST', `/diagrams/${encodeURIComponent(slug)}/fork`);
  }

  private async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(this.base + path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!res.ok) {
      const problem = (await res.json().catch(() => null)) as ProblemDetails | null;
      throw new ApiError(res.status, problem);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
