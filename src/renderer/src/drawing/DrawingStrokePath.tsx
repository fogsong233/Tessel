import { memo, type ReactElement } from 'react';
import type { LanDrawingStroke } from '../../../shared/lanWhiteboard';
import { drawingStrokePath } from './drawingGeometry';

interface DrawingStrokePathProps {
  active?: boolean;
  className?: string;
  opacity?: number;
  stroke: LanDrawingStroke;
}

/**
 * Keeps completed vector paths out of React's live-ink render loop. A canvas
 * with hundreds of strokes should only rebuild the path that is changing.
 */
export const DrawingStrokePath = memo(function DrawingStrokePath({
  active = false,
  className,
  opacity,
  stroke
}: DrawingStrokePathProps): ReactElement {
  return (
    <path
      className={className}
      d={drawingStrokePath(stroke, active)}
      fill={stroke.color}
      opacity={opacity}
    />
  );
});
