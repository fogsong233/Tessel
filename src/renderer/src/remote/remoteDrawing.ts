import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingStroke, LanWhiteboardSide } from '../../../shared/lanWhiteboard';

export interface RemoteDrawingPayload {
  canvasHeight: number;
  canvasWidth: number;
  penOnly: boolean;
  side: LanWhiteboardSide;
  strokes: LanDrawingStroke[];
}

export function remoteDrawingPayload(block: WorkspaceBlock): RemoteDrawingPayload {
  const canvasWidth = finitePositive(block.payload?.canvasWidth, block.width || 612);
  const canvasHeight = finitePositive(block.payload?.canvasHeight, block.height || 792);
  const strokes = Array.isArray(block.payload?.strokes)
    ? block.payload.strokes.filter(isUsableStroke) as LanDrawingStroke[]
    : [];
  return {
    canvasWidth,
    canvasHeight,
    penOnly: block.payload?.penOnly === true,
    side: block.payload?.side === 'left' ? 'left' : 'right',
    strokes
  };
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Math.max(1, fallback);
}

function isUsableStroke(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const stroke = value as Partial<LanDrawingStroke>;
  return typeof stroke.id === 'string'
    && typeof stroke.color === 'string'
    && typeof stroke.size === 'number'
    && Array.isArray(stroke.points)
    && stroke.points.length > 0;
}
