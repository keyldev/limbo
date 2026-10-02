export type * from './loadline.generated.js';

/** Текущая версия формата .loadline.json. */
export const FORMAT_VERSION = 1 as const;

/** Пресет компонента из spec/presets. */
export interface Preset {
  id: string;
  kind: string;
  capacityRps: number;
  baseLatencyMs: number;
  costPerReplicaUsd: number;
  hitRatio?: number;
  /** false, пока значения не сверены с бенчмарком. */
  calibrated: boolean;
  /** Ссылка на бенчмарк, по которому откалиброван пресет. */
  source: string | null;
}
