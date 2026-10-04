/**
 * Схема внутри ссылки: JSON → deflate-raw → base64url. Сжатие встроено в браузер
 * (CompressionStream), зависимостей нет. Префикс — версия кодировки, чтобы её можно
 * было сменить, не ломая старые ссылки.
 */

const PREFIX = '1.';
/** Столько же, сколько принимает сервер (Limits.MaxDocumentBytes): защита от «бомбы» в ссылке. */
export const MAX_DECODED_BYTES = 256 * 1024;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Ссылка повреждена: лишние символы');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Поток из одного куска байтов: Blob.stream() есть не везде (например, в jsdom). */
function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

class TooLargeError extends Error {}

/** Дочитать поток до конца, но не больше limit байт. */
async function readAll(stream: ReadableStream<Uint8Array>, limit = Infinity): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function encodeDoc(doc: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const packed = await readAll(streamOf(json).pipeThrough(new CompressionStream('deflate-raw')));
  return PREFIX + toBase64Url(packed);
}

export async function decodeDoc(data: string): Promise<unknown> {
  if (!data.startsWith(PREFIX))
    throw new Error('Ссылка из более новой версии limbo или повреждена');
  const packed = fromBase64Url(data.slice(PREFIX.length));
  let bytes: Uint8Array;
  try {
    bytes = await readAll(
      streamOf(packed).pipeThrough(new DecompressionStream('deflate-raw')),
      MAX_DECODED_BYTES,
    );
  } catch (e) {
    if (e instanceof TooLargeError) throw new Error('Схема в ссылке больше 256 КБ');
    throw new Error('Ссылка повреждена: не удалось распаковать схему');
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Ссылка повреждена: внутри не JSON');
  }
}
