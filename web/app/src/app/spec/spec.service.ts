import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { migrate } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';

export interface ScenarioInfo {
  file: string;
  title: string;
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
    { file: 'url-shortener.loadline.json', title: 'Сокращатель ссылок' },
    { file: 'chat.loadline.json', title: 'Чат' },
  ];

  async presets(): Promise<Preset[]> {
    const data = await firstValueFrom(this.http.get<{ presets: Preset[] }>('spec/presets/default.json'));
    return data.presets;
  }

  async scenario(file: string): Promise<LoadlineDocument> {
    const raw = await firstValueFrom(this.http.get<unknown>(`spec/scenarios/${file}`));
    return migrate(raw);
  }
}
