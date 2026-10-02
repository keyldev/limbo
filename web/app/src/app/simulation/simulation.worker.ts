/// <reference lib="webworker" />

import { simulate } from '@loadline/engine';
import type { SimulationRequest, SimulationResponse } from './simulation.messages';

addEventListener('message', ({ data }: MessageEvent<SimulationRequest>) => {
  try {
    const result = simulate(data.doc, { presets: data.presets });
    postMessage({ id: data.id, result } satisfies SimulationResponse);
  } catch (e) {
    postMessage({
      id: data.id,
      error: e instanceof Error ? e.message : String(e),
    } satisfies SimulationResponse);
  }
});
