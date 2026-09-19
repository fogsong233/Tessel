import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingStroke, LanWhiteboardClientMessage } from '../../../shared/lanWhiteboard';
import { remoteDrawingPayload } from './remoteDrawing';

export type PendingInk = Extract<LanWhiteboardClientMessage, { type: 'stroke-commit' | 'replace-strokes' }>;

/** Reapply unacknowledged edits to every server snapshot. An earlier save can
 * arrive after the user has already written several more strokes or undone one. */
export function withPendingInk(block: WorkspaceBlock, pending: Iterable<PendingInk>): WorkspaceBlock {
  let result = block;
  for (const operation of pending) {
    if (operation.canvasId !== block.id) continue;
    const strokes = operation.type === 'replace-strokes' ? operation.strokes
      : [...remoteDrawingPayload(result).strokes.filter((stroke) => stroke.id !== operation.stroke.id), operation.stroke];
    result = { ...result, payload: { ...result.payload, strokes } };
  }
  return result;
}

/** WebSocket JSON creates new objects for the whole page on every save. Keep
 * unchanged stroke references so memoized SVG paths do not rebuild old ink. */
export function preserveInkIdentity(block: WorkspaceBlock, previous?: WorkspaceBlock): WorkspaceBlock {
  if (!previous) return block;
  const old = new Map(remoteDrawingPayload(previous).strokes.map((stroke) => [stroke.id, stroke]));
  const strokes = remoteDrawingPayload(block).strokes.map((stroke) => {
    const candidate = old.get(stroke.id);
    return candidate && sameStroke(candidate, stroke) ? candidate : stroke;
  });
  return { ...block, payload: { ...block.payload, strokes } };
}

function sameStroke(a: LanDrawingStroke, b: LanDrawingStroke): boolean {
  return a === b || (a.color === b.color && a.size === b.size && a.smoothing === b.smoothing
    && a.streamline === b.streamline && a.rendering === b.rendering && a.simulatePressure === b.simulatePressure
    && a.createdAt === b.createdAt && a.points.length === b.points.length
    && a.points.every((point, i) => point[0] === b.points[i][0] && point[1] === b.points[i][1] && point[2] === b.points[i][2]));
}
