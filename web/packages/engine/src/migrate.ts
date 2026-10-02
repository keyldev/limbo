import { FORMAT_VERSION, type LoadlineDocument } from '@loadline/model';

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/**
 * Приводит файл любой поддерживаемой версии к текущей.
 * Когда появится v2, сюда добавляется шаг migrateV1toV2.
 */
export function migrate(input: unknown): LoadlineDocument {
  if (typeof input !== 'object' || input === null) {
    throw new UnsupportedFormatError('Это не файл Loadline');
  }
  const doc = input as { format?: unknown; version?: unknown };
  if (doc.format !== 'loadline') {
    throw new UnsupportedFormatError('Поле format должно быть "loadline"');
  }
  if (doc.version === FORMAT_VERSION) {
    return input as LoadlineDocument;
  }
  if (typeof doc.version === 'number' && doc.version > FORMAT_VERSION) {
    throw new UnsupportedFormatError(
      `Файл версии ${doc.version} новее приложения (версия ${FORMAT_VERSION}). Обновите страницу.`,
    );
  }
  throw new UnsupportedFormatError(`Неизвестная версия формата: ${String(doc.version)}`);
}
