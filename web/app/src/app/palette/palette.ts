import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { NodeKind, Preset } from '@loadline/model';
import { PALETTE_MIME } from '../board/board-contract';
import { Icon } from '../catalog/icon';
import { KIND_GROUPS, KINDS, type KindInfo } from '../catalog/kinds';
import { fmt } from '../ui/format';

/** Палитра компонентов: перетащить на доску или кликнуть, чтобы добавить в центр. */
@Component({
  selector: 'll-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @for (g of groups(); track g.name) {
      <section class="group">
        <h3>{{ g.name }}</h3>
        @for (k of g.kinds; track k.kind) {
          <button
            type="button"
            class="part"
            draggable="true"
            (dragstart)="onDragStart($event, k.kind)"
            (click)="add.emit(k.kind)"
            [title]="'Перетащите на доску или кликните, чтобы добавить: ' + k.label.toLowerCase()"
          >
            <span class="ico"><ll-icon [kind]="k.kind" /></span>
            <span class="text">
              {{ k.label }}
              <small>{{ caption(k) }}</small>
            </span>
          </button>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 14px 10px;
      overflow: auto;
      background: var(--ll-surface);
      border-right: 1px solid var(--ll-border);
    }
    .group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    h3 {
      margin: 0 6px 6px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--ll-text-muted);
    }
    .part {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 6px;
      border: 1px solid transparent;
      border-radius: 7px;
      background: none;
      text-align: left;
      cursor: grab;
    }
    .part:hover {
      background: var(--ll-surface-2);
      border-color: var(--ll-border);
    }
    .part:active {
      cursor: grabbing;
    }
    .ico {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 7px;
      background: var(--ll-surface-2);
      border: 1px solid var(--ll-border);
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      font-weight: 500;
    }
    small {
      font: 400 11px var(--ll-mono);
      color: var(--ll-text-muted);
    }
    @media (max-width: 640px) {
      :host {
        flex-direction: row;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 8px 12px;
        gap: 4px;
        border-right: 0;
        border-bottom: 1px solid var(--ll-border);
      }
      .group {
        flex-direction: row;
        gap: 4px;
        flex: none;
      }
      h3,
      small {
        display: none;
      }
      .part {
        width: auto;
        flex: none;
        grid-template-columns: 32px auto;
        padding: 4px 8px 4px 4px;
      }
    }
  `,
})
export class Palette {
  readonly presets = input<Preset[]>([]);
  readonly add = output<NodeKind>();

  protected readonly groups = computed(() =>
    KIND_GROUPS.map((name) => ({ name, kinds: KINDS.filter((k) => k.group === name) })),
  );

  protected caption(k: KindInfo): string {
    if (k.kind === 'client') return 'источник трафика';
    const p = this.presets().find((x) => x.id === k.preset);
    return p ? `${fmt(p.capacityRps)} rps · ${p.baseLatencyMs} мс` : '';
  }

  protected onDragStart(e: DragEvent, kind: NodeKind): void {
    e.dataTransfer?.setData(PALETTE_MIME, kind);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  }
}
