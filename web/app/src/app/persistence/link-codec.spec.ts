import { decodeDoc, encodeDoc, fromBase64Url, toBase64Url } from './link-codec';

const hasStreams =
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

describe('кодек ссылки', () => {
  it('base64url обратим и не содержит + / =', () => {
    const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
  });

  it('отклоняет посторонние символы', () => {
    expect(() => fromBase64Url('abc$')).toThrow(/повреждена/);
  });

  it.runIf(hasStreams)('схема переживает упаковку и распаковку', async () => {
    const doc = { format: 'loadline', version: 1, meta: { title: 'Чат' }, nodes: [{ id: 'a' }] };
    const data = await encodeDoc(doc);
    expect(data.startsWith('1.')).toBe(true);
    expect(await decodeDoc(data)).toEqual(doc);
  });

  it.runIf(hasStreams)('мусор в ссылке даёт понятную ошибку', async () => {
    await expect(decodeDoc('1.AAAA')).rejects.toThrow(/повреждена/);
    await expect(decodeDoc('9.AAAA')).rejects.toThrow(/новой версии/);
  });
});
