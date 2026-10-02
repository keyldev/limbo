import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { LoadlineDocument } from '@loadline/model';
import type {
  BoardConnect,
  BoardKind,
  BoardMove,
  BoardReconnect,
  BoardSelection,
} from './board/board-contract';
import { BoardFoblex } from './board/board-foblex';
import { BoardPreview } from './board/board-preview';
import { BoardVflow } from './board/board-vflow';
import { FpsMeter } from './board/fps-meter';
import { STRESS_SCENARIO, stressDocument } from './board/stress';
import { addEdge, moveNodes, reconnectEdge, removeEdge, removeNode } from './editor/edits';
import { History } from './editor/history';
import { Inspector, type NodeChange } from './inspector/inspector';
import { MetricsPanel } from './metrics/metrics-panel';
import { SimulationService } from './simulation/simulation.service';
import { SpecService } from './spec/spec.service';

type Theme = 'dark' | 'light';

const BOARD_KEY = 'loadline.board';

/** Выбор доски на время сравнения (ADR 0003). Хранилище может быть недоступно: тогда по умолчанию. */
function loadBoardKind(): BoardKind {
  try {
    const v = localStorage.getItem(BOARD_KEY);
    if (v === 'preview' || v === 'foblex' || v === 'vflow') return v;
  } catch {
    // приватный режим или запрет хранилища
  }
  return 'foblex';
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoardPreview, BoardFoblex, BoardVflow, FpsMeter, Inspector, MetricsPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class App {
  protected readonly spec = inject(SpecService);
  protected readonly sim = inject(SimulationService);

  protected readonly stressScenario = STRESS_SCENARIO;
  protected readonly boards: { kind: BoardKind; title: string }[] = [
    { kind: 'foblex', title: 'Foblex Flow' },
    { kind: 'vflow', title: 'ngx-vflow' },
    { kind: 'preview', title: 'SVG-предпросмотр' },
  ];

  protected readonly scenarioFile = signal(this.spec.scenarios[0]!.file);
  /** Растёт при каждой загрузке схемы: доска по нему вписывает схему в экран. */
  protected readonly loadCount = signal(0);
  protected readonly board = signal<BoardKind>(loadBoardKind());
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selectedEdgeId = signal<string | null>(null);
  protected readonly selection = computed<BoardSelection>(() => ({
    nodeId: this.selectedId(),
    edgeId: this.selectedEdgeId(),
  }));
  protected readonly theme = signal<Theme>('dark');
  protected readonly history = new History<LoadlineDocument>();

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
    this.selectSelection({ nodeId: null, edgeId: null });
    const doc = file === STRESS_SCENARIO ? stressDocument() : await this.spec.scenario(file);
    this.history.clear();
    this.sim.doc.set(doc);
    this.loadCount.update((n) => n + 1);
  }

  protected setBoard(kind: BoardKind): void {
    this.board.set(kind);
    this.selectSelection({ nodeId: null, edgeId: null });
    this.loadCount.update((n) => n + 1);
    try {
      localStorage.setItem(BOARD_KEY, kind);
    } catch {
      // не критично: выбор просто не запомнится
    }
  }

  protected selectSelection(s: BoardSelection): void {
    this.selectedId.set(s.nodeId);
    this.selectedEdgeId.set(s.edgeId);
  }

  // Трафик — это ручка симуляции, а не правка схемы: в историю не пишем.
  protected setRps(value: number): void {
    this.update((d) => ({ ...d, traffic: { ...d.traffic, rps: value } }), false);
  }

  protected toggleSpike(): void {
    this.update((d) => ({ ...d, traffic: { ...d.traffic, spike: this.spiking() ? 1 : 4 } }), false);
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

  protected onMove(moves: BoardMove[]): void {
    this.update((d) => moveNodes(d, moves));
  }

  protected onConnect(c: BoardConnect): void {
    this.update((d) => addEdge(d, c));
  }

  protected onReconnect(r: BoardReconnect): void {
    this.update((d) => reconnectEdge(d, r));
  }

  protected undo(): void {
    const d = this.sim.doc();
    const prev = d && this.history.undo(d);
    if (prev) this.sim.doc.set(prev);
  }

  protected redo(): void {
    const d = this.sim.doc();
    const next = d && this.history.redo(d);
    if (next) this.sim.doc.set(next);
  }

  protected deleteSelected(): void {
    const edgeId = this.selectedEdgeId();
    const nodeId = this.selectedId();
    if (edgeId) this.update((d) => removeEdge(d, edgeId));
    else if (nodeId) this.update((d) => removeNode(d, nodeId));
    this.selectSelection({ nodeId: null, edgeId: null });
  }

  protected onKeydown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      this.deleteSelected();
    }
  }

  protected toggleTheme(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.dataset['theme'] = next;
  }

  /** Применяет правку. Если документ не изменился (та же ссылка), в историю ничего не пишется. */
  private update(fn: (d: LoadlineDocument) => LoadlineDocument, record = true): void {
    const d = this.sim.doc();
    if (!d) return;
    const next = fn(d);
    if (next === d) return;
    if (record) this.history.record(d);
    this.sim.doc.set(next);
  }
}
