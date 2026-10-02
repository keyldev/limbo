import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { LogEntry, LogLevel } from '../editor/editor-store';
import { fmtClock } from '../ui/format';

const TAGS: Record<LogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  hot: 'HOT',
  over: 'OVER',
  ok: 'OK',
};

/** Лог событий в стиле терминала: время симуляции, тег уровня, текст. Новые сверху. */
@Component({
  selector: 'll-event-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol aria-label="Лог событий" aria-live="polite">
      @for (l of entries(); track l.id) {
        <li [attr.data-level]="l.level">
          <time>{{ fmtClock(l.t) }}</time>
          <b>{{ tags[l.level] }}</b>
          <span>{{ l.text }}</span>
        </li>
      } @empty {
        <li data-level="info">
          <time>{{ fmtClock(clock()) }}</time>
          <b>{{ tags.info }}</b>
          <span>Все узлы в пределах ёмкости.</span>
        </li>
      }
    </ol>
  `,
  styles: `
    :host {
      display: block;
      height: 118px;
      overflow: auto;
      border-top: 1px solid var(--ll-border);
      background: var(--ll-surface);
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 8px 16px;
      font: 12px/1.65 var(--ll-mono);
    }
    li {
      display: grid;
      grid-template-columns: 48px 44px minmax(0, 1fr);
      gap: 8px;
    }
    time {
      color: var(--ll-text-muted);
    }
    b {
      font-weight: 600;
      color: var(--ll-text-muted);
    }
    span {
      overflow-wrap: anywhere;
    }
    [data-level='warn'] b,
    [data-level='hot'] b {
      color: var(--ll-warm);
    }
    [data-level='over'] b,
    [data-level='over'] span {
      color: var(--ll-hot);
    }
    [data-level='ok'] b {
      color: var(--ll-ok);
    }
  `,
})
export class EventLog {
  readonly entries = input<readonly LogEntry[]>([]);
  readonly clock = input(0);

  protected readonly tags = TAGS;
  protected readonly fmtClock = fmtClock;
}
