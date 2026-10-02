import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { explainNode, resolveNode, type SimulationResult } from '@loadline/engine';
import type { Node as DiagramNode, Preset } from '@loadline/model';

export interface NodeChange {
  id: string;
  replicas?: number;
  outage?: boolean;
}

@Component({
  selector: 'll-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (node(); as n) {
      <header>
        <h2>{{ n.label ?? n.id }}</h2>
        <span class="mono muted">{{ n.kind }}</span>
      </header>

      <div class="row">
        <span>Реплики</span>
        <div class="stepper">
          <button type="button" (click)="emitReplicas(-1)" [disabled]="replicas() <= 1" aria-label="Меньше реплик">−</button>
          <span class="mono">{{ replicas() }}</span>
          <button type="button" (click)="emitReplicas(1)" aria-label="Больше реплик">+</button>
        </div>
      </div>

      <label class="row">
        <span>Simulate outage</span>
        <input type="checkbox" [checked]="n.params?.outage ?? false" (change)="toggleOutage($event)" />
      </label>

      <h3>Как посчитано</h3>
      <ul class="explain">
        @for (x of explanation(); track x.metric) {
          <li>
            <span class="mono muted">{{ x.formula }}</span>
            <span class="mono">{{ x.substituted }}</span>
            <span class="mono strong">{{ x.result }}</span>
          </li>
        }
      </ul>
    } @else {
      <p class="muted">Выберите узел на схеме.</p>
    }
  `,
  styles: `
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    h2 { font-size: 15px; margin: 0 0 12px; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ll-text-muted); margin: 20px 0 8px; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--ll-border); }
    .stepper { display: flex; align-items: center; gap: 10px; }
    .stepper button { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--ll-border); background: var(--ll-surface-2); cursor: pointer; }
    .stepper button:disabled { opacity: 0.4; cursor: default; }
    .explain { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .explain li { display: grid; gap: 2px; font-size: 12px; }
    .mono { font-family: var(--ll-mono); }
    .muted { color: var(--ll-text-muted); }
    .strong { color: var(--ll-text); font-weight: 600; }
  `,
})
export class Inspector {
  readonly node = input<DiagramNode | null>(null);
  readonly result = input<SimulationResult | null>(null);
  readonly presets = input<Preset[]>([]);
  readonly change = output<NodeChange>();

  protected readonly replicas = computed(() => this.node()?.params?.replicas ?? 1);

  protected readonly explanation = computed(() => {
    const n = this.node();
    const m = n ? this.result()?.nodes[n.id] : undefined;
    if (!n || !m) return [];
    return explainNode(resolveNode(n, this.presets(), []), m);
  });

  protected emitReplicas(delta: number): void {
    const n = this.node();
    if (n) this.change.emit({ id: n.id, replicas: Math.max(1, this.replicas() + delta) });
  }

  protected toggleOutage(event: Event): void {
    const n = this.node();
    if (n) this.change.emit({ id: n.id, outage: (event.target as HTMLInputElement).checked });
  }
}
