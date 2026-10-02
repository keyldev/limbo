import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

const WINDOW_MS = 500;

/**
 * Счётчик кадров для сравнения досок (ADR 0003): текущий FPS и худший FPS
 * за последнее перетаскивание (от нажатия кнопки мыши до отпускания).
 */
@Component({
  selector: 'll-fps-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span>{{ fps() }} fps</span>
    @if (dragMin() !== null) {
      <span class="muted">· drag min {{ dragMin() }}</span>
    }
  `,
  styles: `
    :host {
      position: absolute;
      right: 12px;
      bottom: 12px;
      z-index: 5;
      padding: 4px 8px;
      border: 1px solid var(--ll-border);
      border-radius: 6px;
      background: var(--ll-surface);
      font: 11px var(--ll-mono);
      color: var(--ll-text);
      pointer-events: none;
    }
    .muted {
      color: var(--ll-text-muted);
    }
  `,
})
export class FpsMeter {
  protected readonly fps = signal(0);
  protected readonly dragMin = signal<number | null>(null);

  constructor() {
    let frames = 0;
    let windowStart = performance.now();
    let dragging = false;
    let currentMin = Infinity;
    let raf = 0;

    const tick = (now: number): void => {
      frames++;
      const elapsed = now - windowStart;
      if (elapsed >= WINDOW_MS) {
        const value = Math.round((frames * 1000) / elapsed);
        this.fps.set(value);
        if (dragging) currentMin = Math.min(currentMin, value);
        frames = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const down = (): void => {
      dragging = true;
      currentMin = Infinity;
    };
    const up = (): void => {
      if (!dragging) return;
      dragging = false;
      if (Number.isFinite(currentMin)) this.dragMin.set(currentMin);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);

    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
    });
  }
}
