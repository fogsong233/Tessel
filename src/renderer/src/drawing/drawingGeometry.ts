import { getStroke } from 'perfect-freehand';
import type { LanDrawingPoint, LanDrawingStroke } from '../../../shared/lanWhiteboard';

export interface DrawingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawingTransform {
  originX: number;
  originY: number;
  scale: number;
  translateX: number;
  translateY: number;
}

export const inkChunkSize = 64;
export const inkChunkOverlap = 8;

export function drawingStrokePath(stroke: LanDrawingStroke, active = false): string {
  if (stroke.rendering === 'segmented') {
    const paths: string[] = [];
    let start = 0;
    while (stroke.points.length - start > inkChunkSize + inkChunkOverlap) {
      paths.push(outlinePath({ ...stroke, points: stroke.points.slice(start, start + inkChunkSize + inkChunkOverlap) }, false));
      start += inkChunkSize;
    }
    paths.push(outlinePath({ ...stroke, points: stroke.points.slice(start) }, false));
    return paths.join(' ');
  }
  return outlinePath(stroke, active);
}

function outlinePath(stroke: LanDrawingStroke, active: boolean): string {
  const outline = getStroke(stroke.points, {
    size: stroke.size,
    thinning: 0.68,
    smoothing: unitInterval(stroke.smoothing, 0.62),
    streamline: unitInterval(stroke.streamline, 0.48),
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

function unitInterval(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

export function strokeIntersectsPolygon(stroke: LanDrawingStroke, polygon: Array<[number, number]>): boolean {
  if (stroke.points.some(([x, y]) => pointInPolygon([x, y], polygon))) {
    return true;
  }
  const center = stroke.points.reduce<[number, number]>((sum, [x, y]) => [sum[0] + x, sum[1] + y], [0, 0]);
  return pointInPolygon([center[0] / stroke.points.length, center[1] / stroke.points.length], polygon);
}

export function drawingStrokeNearPoint(stroke: LanDrawingStroke, point: LanDrawingPoint, radius: number): boolean {
  const threshold = radius + stroke.size / 2;
  const thresholdSquared = threshold * threshold;
  for (let index = 0; index < stroke.points.length; index += 1) {
    const start = stroke.points[index];
    const end = stroke.points[index + 1] ?? start;
    const segmentX = end[0] - start[0];
    const segmentY = end[1] - start[1];
    const lengthSquared = segmentX * segmentX + segmentY * segmentY;
    const projection = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point[0] - start[0]) * segmentX + (point[1] - start[1]) * segmentY) / lengthSquared))
      : 0;
    const deltaX = point[0] - (start[0] + segmentX * projection);
    const deltaY = point[1] - (start[1] + segmentY * projection);
    if (deltaX * deltaX + deltaY * deltaY <= thresholdSquared) {
      return true;
    }
  }
  return false;
}

export function drawingSelectionBounds(strokes: LanDrawingStroke[], selectedIds: ReadonlySet<string>): DrawingBounds | undefined {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const stroke of strokes) {
    if (!selectedIds.has(stroke.id)) {
      continue;
    }
    const radius = Math.max(2, stroke.size * 0.62);
    for (const [x, y] of stroke.points) {
      minimumX = Math.min(minimumX, x - radius);
      minimumY = Math.min(minimumY, y - radius);
      maximumX = Math.max(maximumX, x + radius);
      maximumY = Math.max(maximumY, y + radius);
    }
  }
  if (!Number.isFinite(minimumX) || !Number.isFinite(minimumY)) {
    return undefined;
  }
  return {
    x: minimumX,
    y: minimumY,
    width: Math.max(1, maximumX - minimumX),
    height: Math.max(1, maximumY - minimumY)
  };
}

export function transformDrawingSelection(
  strokes: LanDrawingStroke[],
  selectedIds: ReadonlySet<string>,
  transform: DrawingTransform,
  canvasWidth: number,
  canvasHeight: number
): LanDrawingStroke[] {
  return strokes.map((stroke) => selectedIds.has(stroke.id) ? {
    ...stroke,
    size: Math.max(0.75, Math.min(96, stroke.size * transform.scale)),
    points: stroke.points.map(([x, y, pressure]) => [
      clamp(transform.originX + (x - transform.originX) * transform.scale + transform.translateX, 0, canvasWidth),
      clamp(transform.originY + (y - transform.originY) * transform.scale + transform.translateY, 0, canvasHeight),
      pressure
    ])
  } : stroke);
}

export function drawingSelectionPng(strokes: LanDrawingStroke[], selectedIds: ReadonlySet<string>): string | undefined {
  const selected = strokes.filter((stroke) => selectedIds.has(stroke.id));
  const bounds = drawingSelectionBounds(selected, new Set(selected.map((stroke) => stroke.id)));
  if (!bounds || selected.length === 0) {
    return undefined;
  }

  const padding = Math.max(14, ...selected.map((stroke) => stroke.size * 1.4));
  const contentWidth = bounds.width + padding * 2;
  const contentHeight = bounds.height + padding * 2;
  const outputScale = Math.min(3, 1_600 / Math.max(contentWidth, contentHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.ceil(contentWidth * outputScale));
  canvas.height = Math.max(64, Math.ceil(contentHeight * outputScale));
  const context = canvas.getContext('2d');
  if (!context) {
    return undefined;
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(outputScale, outputScale);
  context.translate(-bounds.x + padding, -bounds.y + padding);
  for (const stroke of selected) {
    const path = drawingStrokePath(stroke);
    if (!path) {
      continue;
    }
    context.fillStyle = stroke.color;
    context.fill(new Path2D(path));
  }
  return canvas.toDataURL('image/png');
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    if (pointOnSegment(point, polygon[previous], polygon[index])) {
      return true;
    }
  }
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

function pointOnSegment(
  [pointX, pointY]: [number, number],
  [startX, startY]: [number, number],
  [endX, endY]: [number, number]
): boolean {
  const length = Math.hypot(endX - startX, endY - startY);
  if (length < 0.001) {
    return Math.hypot(pointX - startX, pointY - startY) < 0.5;
  }
  const cross = Math.abs((pointX - startX) * (endY - startY) - (pointY - startY) * (endX - startX));
  if (cross / length > 0.5) {
    return false;
  }
  const dot = (pointX - startX) * (endX - startX) + (pointY - startY) * (endY - startY);
  return dot >= -0.5 && dot <= length * length + 0.5;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
