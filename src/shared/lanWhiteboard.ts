import type { DocumentId, WorkspaceBlock } from './domain';

export type LanWhiteboardSide = 'left' | 'right';
export type LanDrawingPoint = [number, number, number];

export interface LanDrawingStroke {
  id: string;
  color: string;
  size: number;
  points: LanDrawingPoint[];
  simulatePressure: boolean;
  createdAt: string;
}

export interface LanWhiteboardContext {
  documentId: DocumentId;
  pageNumber: number;
}

export interface LanWhiteboardDocument {
  id: DocumentId;
  title: string;
  pageCount?: number;
  currentPage: number;
}

export interface LanWhiteboardSnapshot {
  revision: number;
  documents: LanWhiteboardDocument[];
  canvases: WorkspaceBlock[];
  context?: LanWhiteboardContext;
}

export interface LanWhiteboardServerInfo {
  running: boolean;
  port?: number;
  urls: string[];
  clientCount: number;
}

export type LanWhiteboardClientMessage =
  | { type: 'ping'; sentAt: number }
  | { type: 'create-canvas'; requestId: string; documentId?: string; pageNumber?: number; side: LanWhiteboardSide }
  | { type: 'delete-canvas'; requestId: string; canvasId: string }
  | { type: 'stroke-begin'; canvasId: string; stroke: Omit<LanDrawingStroke, 'points'> & { points: LanDrawingPoint[] } }
  | { type: 'stroke-points'; canvasId: string; strokeId: string; points: LanDrawingPoint[] }
  | { type: 'stroke-cancel'; canvasId: string; strokeId: string }
  | { type: 'stroke-commit'; requestId: string; canvasId: string; stroke: LanDrawingStroke }
  | { type: 'replace-strokes'; requestId: string; canvasId: string; strokes: LanDrawingStroke[] };

export type LanWhiteboardServerMessage =
  | { type: 'snapshot'; snapshot: LanWhiteboardSnapshot }
  | { type: 'context'; context?: LanWhiteboardContext }
  | { type: 'canvas-upsert'; block: WorkspaceBlock; revision: number }
  | { type: 'canvas-delete'; blockId: string; revision: number }
  | { type: 'stroke-begin'; canvasId: string; stroke: Omit<LanDrawingStroke, 'points'> & { points: LanDrawingPoint[] } }
  | { type: 'stroke-points'; canvasId: string; strokeId: string; points: LanDrawingPoint[] }
  | { type: 'stroke-cancel'; canvasId: string; strokeId: string }
  | { type: 'ack'; requestId: string; revision: number }
  | { type: 'pong'; sentAt: number; serverAt: number }
  | { type: 'presence'; clientCount: number }
  | { type: 'error'; requestId?: string; message: string };

export type LanWhiteboardRendererEvent = Exclude<LanWhiteboardServerMessage, { type: 'snapshot' | 'ack' | 'pong' }>;

export function isLanDrawingStroke(value: unknown): value is LanDrawingStroke {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const stroke = value as Partial<LanDrawingStroke>;
  return typeof stroke.id === 'string'
    && stroke.id.length > 0
    && typeof stroke.color === 'string'
    && typeof stroke.size === 'number'
    && Number.isFinite(stroke.size)
    && stroke.size > 0
    && stroke.size <= 96
    && typeof stroke.simulatePressure === 'boolean'
    && typeof stroke.createdAt === 'string'
    && Array.isArray(stroke.points)
    && stroke.points.length <= 100_000
    && stroke.points.every(isLanDrawingPoint);
}

export function isLanDrawingPoint(value: unknown): value is LanDrawingPoint {
  return Array.isArray(value)
    && value.length === 3
    && value.every((channel) => typeof channel === 'number' && Number.isFinite(channel));
}
