import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { simulate, type SimulationResult } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';
import type { SimulationRequest, SimulationResponse } from './simulation.messages';

/** Пересчёт не чаще, чем раз в DEBOUNCE_MS: доска не должна ждать движок. */
const DEBOUNCE_MS = 50;

/**
 * Держит текущую схему и результат симуляции.
 * Считает в Web Worker; если воркеры недоступны (тесты, SSR), считает в основном потоке.
 */
@Injectable({ providedIn: 'root' })
export class SimulationService {
  readonly doc = signal<LoadlineDocument | null>(null);
  readonly presets = signal<Preset[]>([]);
  readonly result = signal<SimulationResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  private readonly worker: Worker | null = this.createWorker();
  private lastId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.worker?.addEventListener('message', ({ data }: MessageEvent<SimulationResponse>) => {
      if (data.id !== this.lastId) return; // устаревший ответ
      this.busy.set(false);
      if (data.error) this.error.set(data.error);
      else this.result.set(data.result ?? null);
    });

    effect(() => {
      const doc = this.doc();
      const presets = this.presets();
      if (doc && presets.length > 0) this.schedule(doc, presets);
    });

    inject(DestroyRef).onDestroy(() => this.worker?.terminate());
  }

  private schedule(doc: LoadlineDocument, presets: Preset[]): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(doc, presets), DEBOUNCE_MS);
  }

  private run(doc: LoadlineDocument, presets: Preset[]): void {
    const id = ++this.lastId;
    this.busy.set(true);
    this.error.set(null);
    if (this.worker) {
      this.worker.postMessage({ id, doc, presets } satisfies SimulationRequest);
      return;
    }
    try {
      this.result.set(simulate(doc, { presets }));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  private createWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    return new Worker(new URL('./simulation.worker', import.meta.url), { type: 'module' });
  }
}
