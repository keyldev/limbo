import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  MAX_SOURCE_BYTES,
  SAMPLE_COMPOSE,
  detectSource,
  importConfigs,
  type ImportResult,
  type ImportSource,
  type ImportedService,
} from '@loadline/import';
import { kindInfo } from '../catalog/kinds';

const COMPOSE_NAME = 'docker-compose.yml';
const PROXY_NAME = 'конфиг прокси';

const SKIPPED: Record<NonNullable<ImportedService['skipped']>, string> = {
  job: 'одноразовая задача, связи проведены сквозь неё',
  proxy: 'прозрачный посредник, связи проведены сквозь него',
  infra: 'обвязка, на схему не попадает',
  'scaled-to-zero': 'replicas: 0',
};

/**
 * Окно импорта: docker-compose и, если есть, Caddyfile или nginx.conf. Схема собирается
 * прямо в браузере при каждом изменении текста, до открытия видно, что как угадано.
 */
@Component({
  selector: 'll-import-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="ll-import-title">
      <h2 id="ll-import-title">Импорт из конфигов</h2>
      <p class="note">
        Вставьте docker-compose.yml: типы компонентов угадываются по образам и именам, связи — по
        depends_on, адресам в переменных окружения и конфигу прокси. Всё считается в браузере, файлы
        никуда не уходят.
      </p>

      <div class="sources">
        <label>
          <span>{{ composeName() }}</span>
          <textarea
            spellcheck="false"
            placeholder="services:&#10;  api:&#10;    image: …"
            [value]="compose()"
            (input)="setCompose($any($event.target).value)"
          ></textarea>
        </label>
        <label>
          <span>{{ proxyName() }} <small>необязательно</small></span>
          <textarea
            spellcheck="false"
            placeholder="Caddyfile или nginx.conf"
            [value]="proxy()"
            (input)="setProxy($any($event.target).value)"
          ></textarea>
        </label>
      </div>

      <div class="row">
        <button type="button" (click)="files.click()">Выбрать файлы…</button>
        <input
          #files
          type="file"
          multiple
          hidden
          (change)="addFiles($any($event.target).files); files.value = ''"
        />
        <button type="button" (click)="useSample()">Вставить пример</button>
      </div>

      @if (fileError(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (outcome(); as o) {
        @if (o.error) {
          <p class="error" role="alert">{{ o.error }}</p>
        } @else if (o.result; as r) {
          <h3>Что получится</h3>
          <ul class="services">
            @for (s of r.services; track s.name) {
              <li [class.skipped]="s.skipped">
                <b>{{ s.name }}</b>
                @if (s.kind) {
                  <span class="kind"
                    >{{ kindLabel(s) }}{{ s.replicas > 1 ? ' ×' + s.replicas : '' }}</span
                  >
                } @else {
                  <span class="kind">пропущен: {{ skippedText(s) }}</span>
                }
                <small>{{ s.why }}</small>
              </li>
            }
          </ul>
          @if (r.notes.length) {
            <ul class="notes">
              @for (n of r.notes; track n) {
                <li>{{ n }}</li>
              }
            </ul>
          }
          <p class="note">
            Ёмкости и задержки — пресеты по умолчанию, а не цифры вашей системы. Поправьте их в
            инспекторе узла.
          </p>
        }
      }

      <form method="dialog">
        <button type="submit">Отмена</button>
        <button type="button" class="primary" [disabled]="!outcome()?.result" (click)="apply()">
          Открыть на доске
        </button>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 48px);
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
      margin: 0 0 8px;
      font-size: 16px;
    }
    h3 {
      margin: 16px 0 8px;
      font-size: 13px;
    }
    .note {
      margin: 0 0 12px;
      color: var(--ll-text-muted);
      font-size: 12.5px;
      line-height: 1.5;
    }
    .sources {
      display: grid;
      grid-template-columns: 3fr 2fr;
      gap: 10px;
    }
    @media (max-width: 640px) {
      .sources {
        grid-template-columns: 1fr;
      }
    }
    label {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    label > span {
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--ll-text-muted);
    }
    label small {
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
    }
    textarea {
      height: 180px;
      padding: 8px 10px;
      resize: vertical;
      border: 1px solid var(--ll-border);
      border-radius: 6px;
      background: var(--ll-bg);
      color: var(--ll-text);
      font: 12px/1.45 var(--ll-mono);
      tab-size: 2;
    }
    .row,
    form {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    form {
      justify-content: flex-end;
      margin-top: 16px;
    }
    button {
      height: 32px;
      padding: 0 14px;
      border: 1px solid var(--ll-border);
      border-radius: 6px;
      background: var(--ll-surface-2);
      color: var(--ll-text);
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary {
      border-color: var(--ll-accent);
      background: var(--ll-accent);
      color: var(--ll-accent-ink);
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 12.5px;
    }
    .services {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 4px 16px;
    }
    .services li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0 6px;
      min-width: 0;
    }
    .services b {
      font: 600 12px var(--ll-mono);
    }
    .services small {
      flex-basis: 100%;
      color: var(--ll-text-muted);
    }
    .skipped b,
    .skipped .kind {
      color: var(--ll-text-muted);
    }
    .notes {
      margin-top: 12px;
      padding: 8px 10px;
      border-left: 2px solid var(--ll-accent);
      background: var(--ll-surface-2);
      border-radius: 0 6px 6px 0;
      line-height: 1.6;
    }
    .note:last-child {
      margin-top: 12px;
    }
    .error {
      margin: 12px 0 0;
      color: var(--ll-hot);
    }
  `,
})
export class ImportDialog {
  readonly open = input(false);
  /** Файлы, с которыми окно открыли: например, перетащенные на доску. */
  readonly initial = input<readonly File[]>([]);
  readonly imported = output<ImportResult>();
  readonly closed = output<void>();

  protected readonly compose = signal('');
  protected readonly composeName = signal(COMPOSE_NAME);
  protected readonly proxy = signal('');
  protected readonly proxyName = signal(PROXY_NAME);
  protected readonly fileError = signal<string | null>(null);

  protected readonly outcome = computed((): { result?: ImportResult; error?: string } | null => {
    const sources: ImportSource[] = [
      { name: this.composeName(), text: this.compose() },
      { name: this.proxyName(), text: this.proxy() },
    ].filter((s) => s.text.trim());
    if (!sources.length) return null;
    try {
      return { result: importConfigs(sources) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const open = this.open();
      const el = this.dialog().nativeElement;
      if (open && !el.open) {
        el.showModal();
        const files = this.initial();
        if (files.length) untracked(() => void this.addFiles(files));
      } else if (!open && el.open) {
        el.close();
      }
    });
  }

  protected setCompose(text: string): void {
    this.compose.set(text);
    if (!text.trim()) this.composeName.set(COMPOSE_NAME);
  }

  protected setProxy(text: string): void {
    this.proxy.set(text);
    if (!text.trim()) this.proxyName.set(PROXY_NAME);
  }

  protected useSample(): void {
    this.fileError.set(null);
    this.compose.set(SAMPLE_COMPOSE);
    this.composeName.set(COMPOSE_NAME);
    this.proxy.set('');
    this.proxyName.set(PROXY_NAME);
  }

  /** Раскладывает файлы по полям: compose — в первое, Caddyfile или nginx.conf — во второе. */
  protected async addFiles(files: Iterable<File> | ArrayLike<File>): Promise<void> {
    this.fileError.set(null);
    for (const file of Array.from(files)) {
      if (file.size > MAX_SOURCE_BYTES) {
        this.fileError.set(`${file.name} больше 256 КБ — это не похоже на конфиг`);
        continue;
      }
      const text = await file.text();
      const type = detectSource(file.name, text);
      if (type === 'compose') {
        this.compose.set(text);
        this.composeName.set(file.name);
      } else if (type) {
        this.proxy.set(text);
        this.proxyName.set(file.name);
      } else {
        this.fileError.set(
          `${file.name}: не похоже ни на docker-compose, ни на Caddyfile, ни на nginx.conf`,
        );
      }
    }
  }

  protected apply(): void {
    const result = this.outcome()?.result;
    if (result) this.imported.emit(result);
  }

  protected kindLabel(s: ImportedService): string {
    return s.kind ? kindInfo(s.kind).label : '';
  }

  protected skippedText(s: ImportedService): string {
    return s.skipped ? SKIPPED[s.skipped] : '';
  }
}
