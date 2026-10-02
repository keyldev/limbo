import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Board } from './board/board';
import { FpsMeter } from './board/fps-meter';
import { STRESS_SCENARIO, stressDocument } from './board/stress';
import { EditorStore } from './editor/editor-store';
import { Inspector } from './inspector/inspector';
import { EventLog } from './log/event-log';
import { Palette } from './palette/palette';
import { SimulationService } from './simulation/simulation.service';
import { BLANK_SCENARIO, SpecService, blankDocument } from './spec/spec.service';
import { errorPct, fmt, fmtClock, fmtMs, money, pct, rpsToSlider, sliderToRps } from './ui/format';

type Theme = 'dark' | 'light';

/** ?fps в адресе показывает счётчик кадров и стресс-сценарий на 200 узлов (замер из ADR 0003). */
function benchMode(): boolean {
  try {
    return new URLSearchParams(location.search).has('fps');
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Board, FpsMeter, Inspector, EventLog, Palette],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class App {
  protected readonly spec = inject(SpecService);
  protected readonly sim = inject(SimulationService);
  protected readonly store = inject(EditorStore);

  protected readonly bench = benchMode();
  protected readonly stressScenario = STRESS_SCENARIO;
  protected readonly blankScenario = BLANK_SCENARIO;

  protected readonly fmt = fmt;
  protected readonly fmtMs = fmtMs;
  protected readonly fmtClock = fmtClock;
  protected readonly money = money;
  protected readonly errorPct = errorPct;

  protected readonly scenarioFile = signal(this.spec.scenarios[0]!.file);
  protected readonly theme = signal<Theme>('dark');

  protected readonly rps = computed(() => this.store.doc()?.traffic.rps ?? 0);
  protected readonly effectiveRps = computed(() => this.rps() * (this.store.spiking() ? 4 : 1));
  protected readonly slider = computed(() => rpsToSlider(this.rps()));
  protected readonly system = computed(() => this.store.result()?.system ?? null);

  protected readonly errTone = computed(() => {
    const e = this.system()?.errorRate ?? 0;
    return e > 0.05 ? 'over' : e > 0.001 ? 'hot' : 'ok';
  });

  protected readonly latTone = computed(() => {
    const l = this.system()?.meanLatencyMs ?? 0;
    return l > 600 ? 'over' : l > 250 ? 'hot' : 'ok';
  });

  protected readonly bottleneck = computed(() => {
    const id = this.system()?.bottleneckId;
    const m = id ? this.store.result()?.nodes[id] : undefined;
    if (!id || !m) return null;
    return {
      name: this.store.nameOf(id),
      status: m.status,
      text: m.status === 'down' ? 'down' : pct(m.rho),
    };
  });

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    this.sim.presets.set(await this.spec.presets());
    await this.loadScenario(this.scenarioFile());
  }

  protected async loadScenario(file: string): Promise<void> {
    this.scenarioFile.set(file);
    const doc =
      file === STRESS_SCENARIO
        ? stressDocument()
        : file === BLANK_SCENARIO
          ? blankDocument()
          : await this.spec.scenario(file);
    this.store.load(doc);
  }

  protected setSlider(value: number): void {
    this.store.setRps(sliderToRps(value));
  }

  protected onKeydown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.store.undo();
    } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.store.redo();
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      this.store.removeSelected();
    } else if (key === 'escape') {
      this.store.clearSelection();
    }
  }

  protected toggleTheme(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.dataset['theme'] = next;
  }
}
