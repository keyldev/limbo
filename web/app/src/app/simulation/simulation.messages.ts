import type { SimulationResult } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';

/** Сообщения между SimulationService и simulation.worker. */
export interface SimulationRequest {
  id: number;
  doc: LoadlineDocument;
  presets: Preset[];
}

export interface SimulationResponse {
  id: number;
  result?: SimulationResult;
  error?: string;
}
