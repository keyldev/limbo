import { computed, signal } from '@angular/core';

const LIMIT = 100;

/**
 * Отмена и повтор правок схемы. Хранит снимки документа целиком: документы маленькие
 * и неизменяемые, поэтому снимок — это просто ссылка, без копирования.
 * Не зависит от библиотеки доски.
 */
export class History<T> {
  private readonly past = signal<readonly T[]>([]);
  private readonly future = signal<readonly T[]>([]);

  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);

  /** Запомнить состояние до правки. Любая новая правка обнуляет повтор. */
  record(before: T): void {
    this.past.update((p) => [...p.slice(-(LIMIT - 1)), before]);
    this.future.set([]);
  }

  undo(current: T): T | null {
    const p = this.past();
    const prev = p.at(-1);
    if (prev === undefined) return null;
    this.past.set(p.slice(0, -1));
    this.future.update((f) => [...f, current]);
    return prev;
  }

  redo(current: T): T | null {
    const f = this.future();
    const next = f.at(-1);
    if (next === undefined) return null;
    this.future.set(f.slice(0, -1));
    this.past.update((p) => [...p, current]);
    return next;
  }

  clear(): void {
    this.past.set([]);
    this.future.set([]);
  }
}
