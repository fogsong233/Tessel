import { getStroke } from 'perfect-freehand';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingPoint, LanDrawingStroke, LanWhiteboardSide } from '../../../shared/lanWhiteboard';

export interface RemoteDrawingPayload {
  canvasHeight: number;
  canvasWidth: number;
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
    side: block.payload?.side === 'left' ? 'left' : 'right',
    strokes
  };
}

export function drawingStrokePath(stroke: LanDrawingStroke, active = false): string {
  const outline = getStroke(stroke.points, {
    size: stroke.size,
    thinning: 0.68,
    smoothing: 0.62,
    streamline: 0.48,
    easing: (value) => value,
    simulatePressure: stroke.simulatePressure,
    last: !active,
    start: { taper: 0, cap: true },
    end: { taper: active ? 0 : Math.min(stroke.size * 0.4, 3), cap: true }
  });
  if (outline.length === 0) {
    return '';
  }
  const first = outline[0];
  const commands: Array<string | number> = ['M', first[0], first[1], 'Q'];
  for (let index = 0; index < outline.length; index += 1) {
    const point = outline[index];
    const next = outline[(index + 1) % outline.length];
    commands.push(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
  }
  commands.push('Z');
  return commands.join(' ');
}

export function strokeNearPoint(stroke: LanDrawingStroke, point: LanDrawingPoint, radius: number): boolean {
  const threshold = radius + stroke.size / 2;
  const thresholdSquared = threshold * threshold;
  return stroke.points.some(([x, y]) => {
    const dx = x - point[0];
    const dy = y - point[1];
    return dx * dx + dy * dy <= thresholdSquared;
  });
}

export function strokeIntersectsPolygon(stroke: LanDrawingStroke, polygon: Array<[number, number]>): boolean {
  if (stroke.points.some(([x, y]) => pointInPolygon([x, y], polygon))) {
    return true;
  }
  const center = stroke.points.reduce<[number, number]>((sum, [x, y]) => [sum[0] + x, sum[1] + y], [0, 0]);
  return pointInPolygon([center[0] / stroke.points.length, center[1] / stroke.points.length], polygon);
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x, y] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    if ((y > point[1]) !== (previousY > point[1])
      && point[0] < (previousX - x) * (point[1] - y) / (previousY - y) + x) {
      inside = !inside;
    }
  }
  return inside;
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
