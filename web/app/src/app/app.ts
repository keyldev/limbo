import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { LoadlineDocument } from '@loadline/model';
import { BoardPreview } from './board/board-preview';
import { Inspector, type NodeChange } from './inspector/inspector';
import { MetricsPanel } from './metrics/metrics-panel';
import { SimulationService } from './simulation/simulation.service';
import { SpecService } from './spec/spec.service';

type Theme = 'dark' | 'light';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoardPreview, Inspector, MetricsPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly spec = inject(SpecService);
  protected readonly sim = inject(SimulationService);

  protected readonly scenarioFile = signal(this.spec.scenarios[0]!.file);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly theme = signal<Theme>('dark');

  protected readonly rps = computed(() => this.sim.doc()?.traffic.rps ?? 0);
  protected readonly spiking = computed(() => (this.sim.doc()?.traffic.spike ?? 1) > 1);
  protected readonly selectedNode = computed(
    () => this.sim.doc()?.nodes.find((n) => n.id === this.selectedId()) ?? null,
  );

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    this.sim.presets.set(await this.spec.presets());
    await this.loadScenario(this.scenarioFile());
  }

  protected async loadScenario(file: string): Promise<void> {
    this.scenarioFile.set(file);
    this.selectedId.set(null);
    this.sim.doc.set(await this.spec.scenario(file));
  }

  protected setRps(value: number): void {
    this.update((d) => ({ ...d, traffic: { ...d.traffic, rps: value } }));
  }

  protected toggleSpike(): void {
    this.update((d) => ({ ...d, traffic: { ...d.traffic, spike: this.spiking() ? 1 : 4 } }));
  }

  protected applyNodeChange(c: NodeChange): void {
    this.update((d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.id !== c.id
          ? n
          : {
              ...n,
              params: {
                ...n.params,
                ...(c.replicas !== undefined ? { replicas: c.replicas } : {}),
                ...(c.outage !== undefined ? { outage: c.outage } : {}),
              },
            },
      ),
    }));
  }

  protected toggleTheme(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.dataset['theme'] = next;
  }

  private update(fn: (d: LoadlineDocument) => LoadlineDocument): void {
    const d = this.sim.doc();
    if (d) this.sim.doc.set(fn(d));
  }
}
