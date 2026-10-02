import type { Position } from '@loadline/model';

/**
 * Контракт доски: что приложение отдаёт доске и какие события получает обратно.
 * Приложение не знает про библиотеку доски (сейчас Foblex Flow, ADR 0003), поэтому её можно
 * заменить, не трогая остальное. Порты в событиях — в формате документа: `узел:in` и `узел:out`.
 */

export interface BoardSelection {
  nodeId: string | null;
  edgeId: string | null;
}

export interface BoardMove {
  id: string;
  pos: Position;
}

export interface BoardConnect {
  from: string;
  to: string;
}

export interface BoardReconnect extends BoardConnect {
  edgeId: string;
}

/** MIME-тип перетаскивания компонента из палитры на доску. */
export const PALETTE_MIME = 'application/x-loadline-kind';

export const NODE_W = 188;
export const NODE_H = 78;

export const inPort = (nodeId: string): string => `${nodeId}:in`;
export const outPort = (nodeId: string): string => `${nodeId}:out`;

export function nodeIdOfPort(port: string): string {
  const i = port.lastIndexOf(':');
  return i === -1 ? port : port.slice(0, i);
}
