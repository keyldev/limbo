import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { ImportResult } from '@loadline/import';
import type { LoadlineDocument } from '@loadline/model';
import { Board } from './board/board';
import { FpsMeter } from './board/fps-meter';
import { ImportDialog } from './import/import-dialog';
import { STRESS_SCENARIO, stressDocument } from './board/stress';
import { EditorStore } from './editor/editor-store';
import { Inspector } from './inspector/inspector';
import { EventLog } from './log/event-log';
import { Palette } from './palette/palette';
import { PersistenceService } from './persistence/persistence.service';
import { ShareDialog, type ShareState } from './persistence/share-dialog';
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
  imports: [Board, FpsMeter, ImportDialog, Inspector, EventLog, Palette, ShareDialog],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: {
    '(document:keydown)': 'onKeydown($event)',
    '(window:hashchange)': 'openLink()',
  },
})
export class App {
  protected readonly spec = inject(SpecService);
  protected readonly sim = inject(SimulationService);
  protected readonly store = inject(EditorStore);
  private readonly persistence = inject(PersistenceService);

  protected readonly bench = benchMode();
  protected readonly stressScenario = STRESS_SCENARIO;
  protected readonly blankScenario = BLANK_SCENARIO;

  protected readonly fmt = fmt;
  protected readonly fmtMs = fmtMs;
  protected readonly fmtClock = fmtClock;
  protected readonly money = money;
  protected readonly errorPct = errorPct;

  /** Какой сценарий выбран в списке. Пусто — своя схема (из ссылки, файла или автосохранения). */
  protected readonly scenarioFile = signal('');
  protected readonly share = signal<ShareState>({ status: 'closed' });
  /** Окно импорта из compose: открыто ли и с какими файлами (перетащенными на доску). */
  protected readonly importer = signal<{ open: boolean; files: readonly File[] }>({
    open: false,
    files: [],
  });
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

  /** Что открыть при запуске: ссылку из адреса, иначе автосохранение, иначе первый сценарий. */
  private async init(): Promise<void> {
    this.sim.presets.set(await this.spec.presets());
    if (await this.openLink(true)) return;
    if (!this.restoreAutosave()) await this.loadScenario(this.spec.scenarios[0]!.file, true);
  }

  private restoreAutosave(): boolean {
    const saved = this.persistence.readAutosave();
    if (!saved) return false;
    const at = saved.savedAt.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    this.openDocument(saved.doc, { fresh: true, note: `Восстановлена из браузера (${at}) схема` });
    return true;
  }

  /**
   * Открыть схему из ссылки в адресе: #s=… или #doc=… (ADR 0004), или учебный сценарий
   * #scenario=news-feed — так на сценарии ссылается лендинг. Возвращает, получилось ли.
   */
  protected async openLink(fresh = false): Promise<boolean> {
    const scenario = new URLSearchParams(location.hash.slice(1)).get('scenario');
    if (scenario !== null) {
      this.persistence.clearLocationLink();
      const file = this.spec.scenarios.find((s) => s.file === `${scenario}.loadline.json`)?.file;
      if (!file) {
        if (fresh && !this.restoreAutosave())
          await this.loadScenario(this.spec.scenarios[0]!.file, true);
        this.store.push('warn', `Сценария «${scenario}» нет, открыта прежняя схема`);
        return true;
      }
      // Сценарий ложится поверх своей схемы: Ctrl+Z вернёт её, автосохранение не пропадёт молча.
      const hadOwn = fresh ? this.restoreAutosave() : true;
      await this.loadScenario(file, !hadOwn);
      return true;
    }
    try {
      const linked = await this.persistence.openFromLocation();
      if (!linked) return false;
      this.persistence.clearLocationLink();
      this.openDocument(linked.doc, { fresh, note: 'Открыта по ссылке схема' });
      return true;
    } catch (e) {
      this.persistence.clearLocationLink();
      if (fresh) await this.loadScenario(this.spec.scenarios[0]!.file, true);
      this.store.push('over', `Ссылку открыть не получилось: ${this.message(e)}`);
      return fresh;
    }
  }

  protected async loadScenario(file: string, fresh = false): Promise<void> {
    this.scenarioFile.set(file);
    const doc =
      file === STRESS_SCENARIO
        ? stressDocument()
        : file === BLANK_SCENARIO
          ? blankDocument()
          : await this.spec.scenario(file);
    this.store.load(doc, { fresh });
  }

  private openDocument(doc: LoadlineDocument, opts: { fresh?: boolean; note: string }): void {
    this.scenarioFile.set('');
    this.store.load(doc, opts);
  }

  // ---------- файл и ссылка ----------

  protected exportFile(): void {
    const doc = this.store.doc();
    if (doc) this.persistence.exportFile(doc);
  }

  protected async importFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      this.openDocument(await this.persistence.importFile(file), {
        note: `Открыт файл ${file.name}:`,
      });
    } catch (e) {
      this.store.push('over', `Файл ${file.name} не открылся: ${this.message(e)}`);
    }
  }

  protected onFileDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  /** .loadline.json открывается сразу, остальное (compose, манифесты k8s, Terraform, Caddyfile, nginx.conf) — через окно импорта. */
  protected onFileDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.json'))
      void this.importFile(files[0]);
    else this.importer.set({ open: true, files });
  }

  protected openImporter(): void {
    this.importer.set({ open: true, files: [] });
  }

  protected applyImport(r: ImportResult): void {
    this.importer.set({ open: false, files: [] });
    const skipped = r.services.filter((s) => s.skipped).map((s) => s.name);
    this.openDocument(r.doc, { note: 'Импортирована из конфигов схема' });
    for (const note of [...r.notes].reverse()) this.store.push('info', note);
    this.store.push(
      'warn',
      `Узлов: ${r.doc.nodes.length - 1}` +
        (skipped.length ? `, пропущены: ${skipped.join(', ')}` : '') +
        '. Ёмкости — пресеты по умолчанию, поправьте их в инспекторе',
    );
  }

  protected async shareLink(): Promise<void> {
    const doc = this.store.doc();
    if (!doc) return;
    this.share.set({ status: 'working' });
    try {
      const r = await this.persistence.share(doc);
      this.share.set({ status: 'done', ...r });
    } catch (e) {
      this.share.set({ status: 'error', message: this.message(e) });
    }
  }

  private message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
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
