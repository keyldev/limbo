import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { ApiError, LoadlineApi } from '@loadline/api-client';
import { parseDocument } from '@loadline/engine';
import type { LoadlineDocument } from '@loadline/model';
import { EditorStore } from '../editor/editor-store';
import { MAX_DECODED_BYTES, decodeDoc, encodeDoc } from './link-codec';

const AUTOSAVE_KEY = 'loadline.autosave.v1';
const SHARED_KEY = 'loadline.shared.v1';
const AUTOSAVE_DELAY_MS = 400;
/** Ссылки длиннее этого режут мессенджеры и трекеры задач. */
const INLINE_URL_LIMIT = 8000;
const SHARED_LIMIT = 50;
const SLUG = /^[0-9A-Za-z]{10}$/;

export type ShareKind = 'short' | 'inline';

export interface ShareResult {
  kind: ShareKind;
  url: string;
}

export interface Autosave {
  doc: LoadlineDocument;
  savedAt: Date;
}

/** Ссылка, из которой открыли приложение: короткая (через сервер) или со схемой внутри. */
export type LinkSource = 'short' | 'inline';

/** Хранилище браузера бывает недоступно (приватный режим, запрет сайта): тогда тихо живём без него. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Имя файла из названия схемы: «Веб-приложение» → Веб-приложение.loadline.json. */
export function fileNameFor(doc: LoadlineDocument): string {
  const base = (doc.meta?.title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base || 'loadline'}.loadline.json`;
}

/**
 * Где живёт схема помимо памяти: автосохранение в браузере, файл .loadline.json,
 * короткая ссылка на сервере или ссылка со сжатой схемой внутри.
 */
@Injectable({ providedIn: 'root' })
export class PersistenceService {
  private readonly store = inject(EditorStore);
  private readonly api = new LoadlineApi();
  private warnedQuota = false;

  constructor() {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: LoadlineDocument | null = null;
    const flush = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending) this.writeAutosave(pending);
      pending = null;
    };

    effect(() => {
      const doc = this.store.doc();
      if (!doc) return;
      untracked(() => {
        pending = doc;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, AUTOSAVE_DELAY_MS);
      });
    });

    // Вкладку закрывают раньше, чем сработает таймер: дописываем сразу.
    globalThis.addEventListener?.('pagehide', flush);
    inject(DestroyRef).onDestroy(() => {
      flush();
      globalThis.removeEventListener?.('pagehide', flush);
    });
  }

  // ---------- автосохранение ----------

  readAutosave(): Autosave | null {
    const raw = storage()?.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as { doc: unknown; savedAt: string };
      return { doc: parseDocument(data.doc), savedAt: new Date(data.savedAt) };
    } catch {
      // Битое или устаревшее сохранение не должно ломать запуск.
      storage()?.removeItem(AUTOSAVE_KEY);
      return null;
    }
  }

  private writeAutosave(doc: LoadlineDocument): void {
    try {
      storage()?.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), doc }));
    } catch {
      if (!this.warnedQuota) {
        this.warnedQuota = true;
        this.store.push(
          'warn',
          'Браузер не дал сохранить схему. Сохраните её файлом, чтобы не потерять.',
        );
      }
    }
  }

  // ---------- файл ----------

  exportFile(doc: LoadlineDocument): void {
    const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameFor(doc);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async importFile(file: File): Promise<LoadlineDocument> {
    if (file.size > MAX_DECODED_BYTES)
      throw new Error('Файл больше 256 КБ — это не похоже на схему Loadline');
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error('Файл не похож на JSON');
    }
    return parseDocument(raw);
  }

  // ---------- ссылки ----------

  /**
   * Короткая ссылка через сервер, а если сервера нет — ссылка со схемой внутри.
   * Обе — снимки: правки после этого в ссылку не попадают.
   */
  async share(doc: LoadlineDocument): Promise<ShareResult> {
    try {
      const created = await this.api.createDiagram(doc);
      this.rememberShared(created.slug, created.editToken, doc.meta?.title);
      return { kind: 'short', url: this.linkBase() + '#s=' + created.slug };
    } catch (e) {
      if (!this.serverUnavailable(e)) throw this.explain(e);
    }
    const url = this.linkBase() + '#doc=' + (await encodeDoc(doc));
    if (url.length > INLINE_URL_LIMIT) {
      throw new Error(
        'Сервер ссылок недоступен, а схема слишком большая для ссылки без него. Сохраните её файлом.',
      );
    }
    return { kind: 'inline', url };
  }

  /** Схема из ссылки в адресе страницы, если она там есть. Бросает понятную ошибку, если ссылка битая. */
  async openFromLocation(): Promise<{ doc: LoadlineDocument; source: LinkSource } | null> {
    const params = new URLSearchParams(location.hash.slice(1));
    const slug = params.get('s');
    const data = params.get('doc');
    if (slug !== null) {
      if (!SLUG.test(slug)) throw new Error('В ссылке неправильный идентификатор схемы');
      try {
        const res = await this.api.getDiagram(slug);
        return { doc: parseDocument(res.doc), source: 'short' };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404)
          throw new Error('Схема по ссылке не найдена: её удалили или ссылка неполная');
        if (this.serverUnavailable(e))
          throw new Error(
            'Сервер ссылок недоступен, схему по короткой ссылке открыть не получилось',
          );
        throw e;
      }
    }
    if (data !== null) return { doc: parseDocument(await decodeDoc(data)), source: 'inline' };
    return null;
  }

  /** Убираем ссылку из адреса: дальше схема живёт в автосохранении, а обновление страницы не откатит правки. */
  clearLocationLink(): void {
    history.replaceState(null, '', location.pathname + location.search);
  }

  private linkBase(): string {
    return location.origin + location.pathname;
  }

  /** Сервера нет совсем (статический хостинг, сеть) или он лежит — тогда ссылка без сервера. */
  private serverUnavailable(e: unknown): boolean {
    if (e instanceof ApiError) return e.status === 404 || e.status === 405 || e.status >= 500;
    return e instanceof TypeError;
  }

  private explain(e: unknown): Error {
    if (e instanceof ApiError) {
      if (e.status === 429)
        return new Error('Слишком много ссылок за минуту. Подождите немного и попробуйте снова.');
      if (e.status === 413)
        return new Error('Схема больше 256 КБ — сервер её не примет. Сохраните её файлом.');
      if (e.status === 400)
        return new Error(`Сервер не принял схему: ${e.problem?.title ?? 'ошибка проверки'}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  /** Токен правки показывается один раз: храним его, чтобы потом можно было обновить или удалить ссылку. */
  private rememberShared(slug: string, editToken: string, title?: string): void {
    const s = storage();
    if (!s) return;
    try {
      const list = JSON.parse(s.getItem(SHARED_KEY) ?? '[]') as unknown[];
      const entry = { slug, editToken, title: title ?? null, createdAt: new Date().toISOString() };
      s.setItem(SHARED_KEY, JSON.stringify([entry, ...list].slice(0, SHARED_LIMIT)));
    } catch {
      // не критично: ссылка работает и без сохранённого токена
    }
  }
}
