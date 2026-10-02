import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { migrate } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';

export interface ScenarioInfo {
  file: string;
  title: string;
}

/** Не файл, а пустая доска с одним клиентом. */
export const BLANK_SCENARIO = '__blank';

export function blankDocument(): LoadlineDocument {
  return {
    format: 'loadline',
    version: 1,
    meta: { title: 'Пустая доска' },
    traffic: { rps: 500, readShare: 0.8, spike: 1 },
    nodes: [
      {
        id: 'users',
        kind: 'client',
        label: 'Пользователи',
        preset: 'client.default',
        pos: { x: 0, y: 204 },
      },
    ],
    edges: [],
  };
}

/**
 * Загружает пресеты и эталонные сценарии из spec/.
 * При сборке angular.json копирует ../../spec в /spec как статику.
 */
@Injectable({ providedIn: 'root' })
export class SpecService {
  private readonly http = inject(HttpClient);

  /** Пока список статичный; в этапе 3 его отдаст GET /api/v1/scenarios. */
  readonly scenarios: ScenarioInfo[] = [
    { file: 'web-app.loadline.json', title: 'Веб-приложение' },
    { file: 'url-shortener.loadline.json', title: 'Сокращатель ссылок' },
    { file: 'chat.loadline.json', title: 'Чат' },
    { file: 'telemetry.loadline.json', title: 'Телеметрия' },
    { file: 'news-feed.loadline.json', title: 'Лента новостей' },
  ];

  async presets(): Promise<Preset[]> {
    const data = await firstValueFrom(
      this.http.get<{ presets: Preset[] }>('spec/presets/default.json'),
    );
    return data.presets;
  }

  async scenario(file: string): Promise<LoadlineDocument> {
    const raw = await firstValueFrom(this.http.get<unknown>(`spec/scenarios/${file}`));
    return migrate(raw);
  }
}
