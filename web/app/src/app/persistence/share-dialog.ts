import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { ShareKind } from './persistence.service';

export type ShareState =
  | { status: 'closed' }
  | { status: 'working' }
  | { status: 'done'; kind: ShareKind; url: string }
  | { status: 'error'; message: string };

/** Окно со ссылкой на схему: ссылка, кнопка «Скопировать» и что это за ссылка. */
@Component({
  selector: 'll-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="ll-share-title">
      <h2 id="ll-share-title">Ссылка на схему</h2>
      @if (state().status === 'working') {
        <p class="note">Готовлю ссылку…</p>
      } @else if (done(); as d) {
        <div class="row">
          <input
            #link
            type="text"
            readonly
            [value]="d.url"
            (focus)="link.select()"
            aria-label="Ссылка"
          />
          <button type="button" class="primary" (click)="copy(d.url, link)">
            {{ copied() ? 'Скопировано' : 'Скопировать' }}
          </button>
        </div>
        <p class="note">
          @if (d.kind === 'short') {
            Короткая ссылка: схема сохранена на сервере.
          } @else {
            Сервер ссылок недоступен, поэтому схема целиком упакована в саму ссылку. Работает без
            сервера, но ссылка длинная.
          }
          Это снимок: правки после этого в ссылку не попадут, для новой версии сделайте новую
          ссылку.
        </p>
      } @else if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <form method="dialog">
        <button type="submit">Закрыть</button>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, calc(100vw - 32px));
      padding: 20px;
      border: 1px solid var(--ll-border);
      border-radius: 10px;
      background: var(--ll-surface);
      color: var(--ll-text);
      box-shadow: var(--ll-shadow);
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 14px;
      font-size: 16px;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    input {
      flex: 1;
      min-width: 0;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--ll-border);
      border-radius: 6px;
      background: var(--ll-bg);
      font: 12.5px var(--ll-mono);
    }
    button {
      height: 34px;
      padding: 0 14px;
      border: 1px solid var(--ll-border);
      border-radius: 6px;
      background: var(--ll-surface-2);
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary {
      border-color: var(--ll-accent);
      background: var(--ll-accent);
      color: var(--ll-accent-ink);
    }
    .note {
      margin: 12px 0 0;
      color: var(--ll-text-muted);
      font-size: 12.5px;
      line-height: 1.5;
    }
    .error {
      margin: 0;
      color: var(--ll-hot);
    }
    form {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
    }
  `,
})
export class ShareDialog {
  readonly state = input<ShareState>({ status: 'closed' });
  readonly closed = output<void>();

  protected readonly copied = signal(false);
  protected readonly done = computed(() => {
    const s = this.state();
    return s.status === 'done' ? s : null;
  });
  protected readonly error = computed(() => {
    const s = this.state();
    return s.status === 'error' ? s.message : null;
  });
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const open = this.state().status !== 'closed';
      const el = this.dialog().nativeElement;
      if (open && !el.open) {
        this.copied.set(false);
        el.showModal();
      } else if (!open && el.open) {
        el.close();
      }
    });
  }

  protected async copy(url: string, field: HTMLInputElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
    } catch {
      // Буфер обмена запрещён (не https, политика браузера): выделяем — скопирует сам.
      field.focus();
      field.select();
    }
  }
}
