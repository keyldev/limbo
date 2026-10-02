import type { Position } from '@loadline/model';

/**
 * Общий контракт доски. Обе библиотеки-кандидата (ADR 0003) и временный SVG-предпросмотр
 * получают одни и те же входы и отдают одни и те же события, поэтому приложение не знает,
 * какая доска сейчас стоит. Порты в событиях — в формате документа: `узел:in` и `узел:out`.
 */

export type BoardKind = 'preview' | 'foblex' | 'vflow';

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

export const NODE_W = 140;
export const NODE_H = 56;

export const inPort = (nodeId: string): string => `${nodeId}:in`;
export const outPort = (nodeId: string): string => `${nodeId}:out`;

export function nodeIdOfPort(port: string): string {
  const i = port.lastIndexOf(':');
  return i === -1 ? port : port.slice(0, i);
}
