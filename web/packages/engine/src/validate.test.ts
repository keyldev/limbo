import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidDocumentError, parseDocument, validateDocument } from './validate.js';

const SPEC = resolve(__dirname, '../../../../spec');
const scenarioFiles = readdirSync(join(SPEC, 'scenarios')).filter((f) => f.endsWith('.loadline.json'));

const base = () => ({
  format: 'loadline',
  version: 1,
  traffic: { rps: 100 },
  nodes: [
    { id: 'c', kind: 'client', pos: { x: 0, y: 0 } },
    { id: 's', kind: 'service', pos: { x: 200, y: 0 }, params: { replicas: 2 } },
  ],
  edges: [{ id: 'e1', from: 'c:out', to: 's:in' }],
});

describe('проверка документа', () => {
  it.each(scenarioFiles)('эталонный сценарий %s проходит', (file) => {
    const doc = JSON.parse(readFileSync(join(SPEC, 'scenarios', file), 'utf8'));
    expect(validateDocument(doc)).toEqual([]);
  });

  it('находит типичные поломки', () => {
    const doc = base() as Record<string, unknown> & ReturnType<typeof base>;
    doc.nodes.push({ id: 's', kind: 'robot' as 'service', pos: { x: 0, y: 0 } });
    (doc.nodes[1]!.params as Record<string, unknown>)['replicas'] = 0;
    doc.edges.push({ id: 'e2', from: 's:out', to: 'ghost:in' });
    (doc.edges[0] as Record<string, unknown>)['only'] = 'both';
    (doc as Record<string, unknown>)['extra'] = true;
    const problems = validateDocument(doc);
    expect(problems).toEqual(
      expect.arrayContaining([
        'схема: лишнее поле «extra»',
        'nodes[2].id: повтор «s»',
        'nodes[2].kind: неизвестный тип',
        'nodes[1].params.replicas: не меньше 1',
        'edges[1].to: нет узла «ghost»',
        'edges[0].only: read или write',
      ]),
    );
  });

  it('parseDocument бросает понятную ошибку', () => {
    expect(() => parseDocument({ ...base(), traffic: {} })).toThrow(InvalidDocumentError);
    expect(() => parseDocument({ format: 'drawio' })).toThrow(/format/);
    expect(parseDocument(base()).nodes).toHaveLength(2);
  });
});
