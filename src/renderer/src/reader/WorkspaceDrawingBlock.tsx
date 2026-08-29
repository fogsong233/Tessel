import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState
} from 'react';
import { CircleDashed, PenLine, Trash2, Undo2, X } from 'lucide-react';
import { getStroke } from 'perfect-freehand';
import type { WorkspaceBlock } from '../../../shared/domain';
import { createId } from '../../../shared/ids';
import type { LanDrawingPoint, LanDrawingStroke } from '../../../shared/lanWhiteboard';
import {
  createStylusPressureState,
  normalizeStylusPressure,
  type StylusPressureState
} from './drawingPressure';

type DrawingTool = 'pen' | 'lasso';
type DrawingPoint = LanDrawingPoint;
type DrawingStroke = LanDrawingStroke;

interface DrawingPayload {
  canvasHeight: number;
  canvasWidth: number;
  side: 'left' | 'right';
  strokes: DrawingStroke[];
}

export interface WorkspaceDrawingLabels {
  clearCanvas: string;
  delete: string;
  deleteSelection: string;
  drawingColor: string;
  drawingSize: string;
  lassoTool: string;
  penTool: string;
  undoStroke: string;
}

interface WorkspaceDrawingBlockProps {
  block: WorkspaceBlock;
  height: number;
  remoteStrokes?: LanDrawingStroke[];
  text: WorkspaceDrawingLabels;
  width: number;
  onDelete(): void;
  onSave(block: WorkspaceBlock): void;
}

const drawingColors = ['#171717', '#2563eb', '#dc2626', '#16a34a', '#9333ea'];

export function WorkspaceDrawingBlock({
  block,
  height,
  remoteStrokes = [],
  text,
  width,
  onDelete,
  onSave
}: WorkspaceDrawingBlockProps): ReactElement {
  const payload = drawingBlockPayload(block);
  const [strokes, setStrokes] = useState(payload.strokes);
  const [activePoints, setActivePoints] = useState<DrawingPoint[]>([]);
  const [lassoPoints, setLassoPoints] = useState<Array<[number, number]>>([]);
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [color, setColor] = useState(drawingColors[0]);
  const [size, setSize] = useState(4);
  const activePointsRef = useRef<DrawingPoint[]>([]);
  const activePointerRef = useRef<number>();
  const activeSimulatePressureRef = useRef(true);
  const activePressureStateRef = useRef<StylusPressureState>(createStylusPressureState());
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setStrokes(payload.strokes);
    setSelectedStrokeIds(new Set());
  }, [block.id, block.updatedAt]);

  const saveStrokes = (nextStrokes: DrawingStroke[]): void => {
    setStrokes(nextStrokes);
    onSave({
      ...block,
      payload: {
        ...block.payload,
        strokes: nextStrokes
      },
      updatedAt: new Date().toISOString()
    });
  };

  const eventPoint = (clientX: number, clientY: number, pressure = 0.5): DrawingPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    const normalizedPressure = activeSimulatePressureRef.current
      ? 0.5
      : normalizeStylusPressure(pressure, activePressureStateRef.current);
    if (!rect?.width || !rect.height) {
      return [0, 0, normalizedPressure];
    }
    return [
      clamp((clientX - rect.left) * payload.canvasWidth / rect.width, 0, payload.canvasWidth),
      clamp((clientY - rect.top) * payload.canvasHeight / rect.height, 0, payload.canvasHeight),
      normalizedPressure
    ];
  };

  const beginStroke = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      // Let the event bubble to the PDF viewport, which treats the modifier as
      // a temporary hand tool without creating a whiteboard stroke.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic regression events do not register an OS-level active
      // pointer, while real pen/touch events still receive pointer capture.
    }
    activePointerRef.current = event.pointerId;
    activeSimulatePressureRef.current = event.pointerType !== 'pen';
    activePressureStateRef.current = createStylusPressureState();
    const point = eventPoint(event.clientX, event.clientY, event.pressure);
    if (tool === 'pen') {
      activePointsRef.current = [point];
      setActivePoints([point]);
      setSelectedStrokeIds(new Set());
    } else {
      setLassoPoints([[point[0], point[1]]]);
    }
  };

  const extendStroke = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (activePointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];
    const points = samples.map((sample) => eventPoint(sample.clientX, sample.clientY, sample.pressure));
    if (tool === 'pen') {
      const next = [...activePointsRef.current, ...points];
      activePointsRef.current = next;
      setActivePoints(next);
    } else {
      setLassoPoints((current) => [...current, ...points.map(([x, y]) => [x, y] as [number, number])]);
    }
  };

  const finishStroke = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (activePointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerRef.current = undefined;

    if (tool === 'pen') {
      const points = activePointsRef.current;
      if (points.length > 0) {
        saveStrokes([...strokes, {
          id: createId('stroke'),
          color,
          size,
          points,
          simulatePressure: activeSimulatePressureRef.current,
          createdAt: new Date().toISOString()
        }]);
      }
      activePointsRef.current = [];
      setActivePoints([]);
      return;
    }

    setLassoPoints((polygon) => {
      if (polygon.length >= 3) {
        setSelectedStrokeIds(new Set(strokes
          .filter((stroke) => strokeIntersectsPolygon(stroke, polygon))
          .map((stroke) => stroke.id)));
      }
      return [];
    });
  };

  const removeSelection = (): void => {
    if (selectedStrokeIds.size === 0) {
      return;
    }
    saveStrokes(strokes.filter((stroke) => !selectedStrokeIds.has(stroke.id)));
    setSelectedStrokeIds(new Set());
  };

  const activeStroke: DrawingStroke | undefined = activePoints.length > 0 ? {
    id: 'active',
    color,
    size,
    points: activePoints,
    simulatePressure: activeSimulatePressureRef.current,
    createdAt: ''
  } : undefined;

  return (
    <div className="workspace-drawing" style={{ width, height }}>
      <div className="workspace-drawing__toolbar" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className={tool === 'pen' ? 'is-active' : ''} title={text.penTool} aria-label={text.penTool} onClick={() => setTool('pen')}>
          <PenLine size={15} />
        </button>
        <button type="button" className={tool === 'lasso' ? 'is-active' : ''} title={text.lassoTool} aria-label={text.lassoTool} onClick={() => setTool('lasso')}>
          <CircleDashed size={15} />
        </button>
        <span className="workspace-drawing__divider" />
        {drawingColors.map((preset) => (
          <button
            type="button"
            key={preset}
            className={`workspace-drawing__color${color === preset ? ' is-active' : ''}`}
            style={{ '--drawing-color': preset } as CSSProperties}
            title={text.drawingColor}
            aria-label={`${text.drawingColor} ${preset}`}
            onClick={() => setColor(preset)}
          />
        ))}
        <label className="workspace-drawing__custom-color" title={text.drawingColor}>
          <input type="color" value={color} aria-label={text.drawingColor} onChange={(event) => setColor(event.target.value)} />
        </label>
        <label className="workspace-drawing__size" title={text.drawingSize}>
          <span style={{ width: size, height: size }} />
          <input type="range" min="1" max="28" step="1" value={size} aria-label={text.drawingSize} onChange={(event) => setSize(Number(event.target.value))} />
        </label>
        <span className="workspace-drawing__spacer" />
        <button type="button" title={text.undoStroke} aria-label={text.undoStroke} disabled={strokes.length === 0} onClick={() => saveStrokes(strokes.slice(0, -1))}>
          <Undo2 size={15} />
        </button>
        <button type="button" title={text.deleteSelection} aria-label={text.deleteSelection} disabled={selectedStrokeIds.size === 0} onClick={removeSelection}>
          <Trash2 size={15} />
        </button>
        <button type="button" title={text.clearCanvas} aria-label={text.clearCanvas} disabled={strokes.length === 0} onClick={() => saveStrokes([])}>
          <X size={15} />
        </button>
        <button type="button" className="is-danger" title={text.delete} aria-label={text.delete} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      </div>
      <svg
        ref={svgRef}
        className={`workspace-drawing__surface is-${tool}`}
        viewBox={`0 0 ${payload.canvasWidth} ${payload.canvasHeight}`}
        preserveAspectRatio="none"
        onPointerDown={beginStroke}
        onPointerMove={extendStroke}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      >
        {strokes.map((stroke) => (
          <path
            key={stroke.id}
            className={selectedStrokeIds.has(stroke.id) ? 'is-selected' : undefined}
            d={drawingStrokePath(stroke)}
            fill={stroke.color}
          />
        ))}
        {remoteStrokes.map((stroke) => (
          <path key={`remote-${stroke.id}`} d={drawingStrokePath({ ...stroke, id: 'active' })} fill={stroke.color} opacity="0.78" />
        ))}
        {activeStroke && <path d={drawingStrokePath(activeStroke)} fill={activeStroke.color} />}
        {lassoPoints.length > 1 && <polyline className="workspace-drawing__lasso" points={lassoPoints.map((point) => point.join(',')).join(' ')} />}
      </svg>
    </div>
  );
}

export function drawingBlockSide(block: WorkspaceBlock): 'left' | 'right' {
  return block.payload?.side === 'left' ? 'left' : 'right';
}

function drawingBlockPayload(block: WorkspaceBlock): DrawingPayload {
  const canvasWidth = typeof block.payload?.canvasWidth === 'number' && block.payload.canvasWidth > 0
    ? block.payload.canvasWidth
    : Math.max(1, block.width);
  const canvasHeight = typeof block.payload?.canvasHeight === 'number' && block.payload.canvasHeight > 0
    ? block.payload.canvasHeight
    : Math.max(1, block.height ?? 792);
  const rawStrokes = Array.isArray(block.payload?.strokes) ? block.payload.strokes : [];
  return {
    canvasWidth,
    canvasHeight,
    side: drawingBlockSide(block),
    strokes: rawStrokes.flatMap((value): DrawingStroke[] => {
      if (!value || typeof value !== 'object') {
        return [];
      }
      const stroke = value as Record<string, unknown>;
      const points = Array.isArray(stroke.points)
        ? stroke.points.flatMap((point): DrawingPoint[] => (
          Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
            ? [[point[0], point[1], typeof point[2] === 'number' ? clamp(point[2], 0.01, 1) : 0.5]]
            : []
        ))
        : [];
      if (points.length === 0) {
        return [];
      }
      return [{
        id: typeof stroke.id === 'string' ? stroke.id : createId('stroke'),
        color: typeof stroke.color === 'string' ? stroke.color : drawingColors[0],
        size: typeof stroke.size === 'number' ? clamp(stroke.size, 1, 40) : 4,
        points,
        simulatePressure: stroke.simulatePressure !== false,
        createdAt: typeof stroke.createdAt === 'string' ? stroke.createdAt : new Date().toISOString()
      }];
    })
  };
}

function drawingStrokePath(stroke: DrawingStroke): string {
  const outline = getStroke(stroke.points, {
    size: stroke.size,
    thinning: 0.68,
    smoothing: 0.62,
    streamline: 0.48,
    easing: (value) => value,
    simulatePressure: stroke.simulatePressure,
    last: stroke.id !== 'active',
    start: { taper: 0, cap: true },
    end: { taper: Math.min(stroke.size * 0.4, 3), cap: true }
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

function strokeIntersectsPolygon(stroke: DrawingStroke, polygon: Array<[number, number]>): boolean {
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
    if ((y > point[1]) !== (previousY > point[1]) && point[0] < (previousX - x) * (point[1] - y) / (previousY - y) + x) {
      inside = !inside;
    }
  }
  return inside;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
