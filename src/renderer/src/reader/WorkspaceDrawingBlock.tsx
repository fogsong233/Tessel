import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { ArrowLeftRight, ChevronUp, CircleDashed, ImagePlus, Maximize2, PenLine, PenTool, SlidersHorizontal, Trash2, Undo2, X } from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import { createId } from '../../../shared/ids';
import type { LanDrawingPoint, LanDrawingStroke } from '../../../shared/lanWhiteboard';
import {
  drawingSelectionBounds,
  drawingStrokeNearPoint,
  drawingStrokePath,
  strokeIntersectsPolygon,
  transformDrawingSelection,
  type DrawingBounds
} from '../drawing/drawingGeometry';
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
  penOnly: boolean;
  side: 'left' | 'right';
  strokes: DrawingStroke[];
}

interface SelectionGesture {
  bounds: DrawingBounds;
  mode: 'move' | 'resize';
  originalStrokes: DrawingStroke[];
  pointerId: number;
  startX: number;
  startY: number;
}

export interface WorkspaceDrawingLabels {
  clearCanvas: string;
  delete: string;
  deleteSelection: string;
  drawingColor: string;
  drawingSize: string;
  hideDrawingToolbar: string;
  lassoTool: string;
  penOnlyMode: string;
  sendSelectionToAi: string;
  moveSelection: string;
  resizeSelection: string;
  moveCanvasToLeft: string;
  moveCanvasToRight: string;
  canvasSideOccupied: string;
  penTool: string;
  showDrawingToolbar: string;
  undoStroke: string;
}

interface WorkspaceDrawingBlockProps {
  block: WorkspaceBlock;
  canMoveSide: boolean;
  height: number;
  remoteStrokes?: LanDrawingStroke[];
  showPlacementControl?: boolean;
  text: WorkspaceDrawingLabels;
  width: number;
  onMoveSide(): void;
  onShareSelection(strokes: DrawingStroke[]): void;
  onSave(block: WorkspaceBlock): void;
}

const drawingColors = ['#171717', '#2563eb', '#dc2626', '#16a34a', '#9333ea'];

export function WorkspaceDrawingBlock({
  block,
  canMoveSide,
  height,
  remoteStrokes = [],
  showPlacementControl = true,
  text,
  width,
  onMoveSide,
  onShareSelection,
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
  const [penOnly, setPenOnly] = useState(payload.penOnly);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const [temporaryEraser, setTemporaryEraser] = useState(false);
  const activePointsRef = useRef<DrawingPoint[]>([]);
  const activePointerRef = useRef<number>();
  const activeSimulatePressureRef = useRef(true);
  const activePressureStateRef = useRef<StylusPressureState>(createStylusPressureState());
  const svgRef = useRef<SVGSVGElement>(null);
  const strokesRef = useRef(strokes);
  const selectionGestureRef = useRef<SelectionGesture>();
  const stylusHoldRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const temporaryEraserPointerRef = useRef<number>();
  const eraserChangedRef = useRef(false);
  const previousBlockIdRef = useRef(block.id);

  useEffect(() => {
    const blockChanged = previousBlockIdRef.current !== block.id;
    previousBlockIdRef.current = block.id;
    setStrokes(payload.strokes);
    strokesRef.current = payload.strokes;
    setPenOnly(payload.penOnly);
    setSelectedStrokeIds((current) => blockChanged
      ? new Set()
      : new Set([...current].filter((id) => payload.strokes.some((stroke) => stroke.id === id))));
  }, [block.id, block.updatedAt]);

  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  useEffect(() => () => {
    if (stylusHoldRef.current) {
      clearTimeout(stylusHoldRef.current.timer);
    }
  }, []);

  const selectionBounds = useMemo(
    () => drawingSelectionBounds(strokes, selectedStrokeIds),
    [selectedStrokeIds, strokes]
  );

  const saveStrokes = (nextStrokes: DrawingStroke[]): void => {
    strokesRef.current = nextStrokes;
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

  const savePenOnly = (nextPenOnly: boolean): void => {
    setPenOnly(nextPenOnly);
    onSave({
      ...block,
      payload: { ...block.payload, penOnly: nextPenOnly },
      updatedAt: new Date().toISOString()
    });
  };

  const canvasCoordinates = (clientX: number, clientY: number): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) {
      return [0, 0];
    }
    return [
      clamp((clientX - rect.left) * payload.canvasWidth / rect.width, 0, payload.canvasWidth),
      clamp((clientY - rect.top) * payload.canvasHeight / rect.height, 0, payload.canvasHeight)
    ];
  };

  const eventPoint = (clientX: number, clientY: number, pressure = 0.5): DrawingPoint => {
    const normalizedPressure = activeSimulatePressureRef.current
      ? 0.5
      : normalizeStylusPressure(pressure, activePressureStateRef.current);
    const [x, y] = canvasCoordinates(clientX, clientY);
    return [x, y, normalizedPressure];
  };

  const cancelStylusHold = (pointerId?: number): void => {
    const hold = stylusHoldRef.current;
    if (!hold || (pointerId !== undefined && hold.pointerId !== pointerId)) {
      return;
    }
    clearTimeout(hold.timer);
    stylusHoldRef.current = undefined;
  };

  const eraseAt = (point: DrawingPoint): void => {
    const next = strokesRef.current.filter((stroke) => !drawingStrokeNearPoint(stroke, point, Math.max(8, size * 1.8)));
    if (next.length === strokesRef.current.length) {
      return;
    }
    eraserChangedRef.current = true;
    strokesRef.current = next;
    setStrokes(next);
  };

  const armStylusEraser = (event: ReactPointerEvent<SVGSVGElement>, point: DrawingPoint): void => {
    if (event.pointerType !== 'pen' || tool !== 'pen') {
      return;
    }
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const timer = setTimeout(() => {
      if (activePointerRef.current !== pointerId || tool !== 'pen') {
        return;
      }
      stylusHoldRef.current = undefined;
      activePointsRef.current = [];
      setActivePoints([]);
      eraserChangedRef.current = false;
      temporaryEraserPointerRef.current = pointerId;
      setTemporaryEraser(true);
      eraseAt(point);
      navigator.vibrate?.(12);
    }, 480);
    stylusHoldRef.current = { pointerId, startClientX, startClientY, timer };
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
    if (tool === 'pen' && penOnly && event.pointerType !== 'pen') {
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
      armStylusEraser(event, point);
    } else {
      setLassoPoints([[point[0], point[1]]]);
    }
  };

  const extendStroke = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const selectionGesture = selectionGestureRef.current;
    if (selectionGesture?.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const [x, y] = canvasCoordinates(event.clientX, event.clientY);
      if (selectionGesture.mode === 'move') {
        const minimumX = -selectionGesture.bounds.x;
        const maximumX = payload.canvasWidth - selectionGesture.bounds.x - selectionGesture.bounds.width;
        const minimumY = -selectionGesture.bounds.y;
        const maximumY = payload.canvasHeight - selectionGesture.bounds.y - selectionGesture.bounds.height;
        const next = transformDrawingSelection(selectionGesture.originalStrokes, selectedStrokeIds, {
          originX: selectionGesture.bounds.x,
          originY: selectionGesture.bounds.y,
          scale: 1,
          translateX: clamp(x - selectionGesture.startX, minimumX, maximumX),
          translateY: clamp(y - selectionGesture.startY, minimumY, maximumY)
        }, payload.canvasWidth, payload.canvasHeight);
        strokesRef.current = next;
        setStrokes(next);
      } else {
        const scaleX = (x - selectionGesture.bounds.x) / selectionGesture.bounds.width;
        const scaleY = (y - selectionGesture.bounds.y) / selectionGesture.bounds.height;
        const maximumScale = Math.min(
          (payload.canvasWidth - selectionGesture.bounds.x) / selectionGesture.bounds.width,
          (payload.canvasHeight - selectionGesture.bounds.y) / selectionGesture.bounds.height,
          8
        );
        const scale = clamp(Math.max(scaleX, scaleY), 0.2, maximumScale);
        const next = transformDrawingSelection(selectionGesture.originalStrokes, selectedStrokeIds, {
          originX: selectionGesture.bounds.x,
          originY: selectionGesture.bounds.y,
          scale,
          translateX: 0,
          translateY: 0
        }, payload.canvasWidth, payload.canvasHeight);
        strokesRef.current = next;
        setStrokes(next);
      }
      return;
    }
    if (activePointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];
    const points = samples.map((sample) => eventPoint(sample.clientX, sample.clientY, sample.pressure));
    const hold = stylusHoldRef.current;
    if (hold?.pointerId === event.pointerId
      && Math.hypot(event.clientX - hold.startClientX, event.clientY - hold.startClientY) > 8) {
      cancelStylusHold(event.pointerId);
    }
    if (temporaryEraserPointerRef.current === event.pointerId) {
      for (const point of points) {
        eraseAt(point);
      }
      return;
    }
    if (tool === 'pen') {
      const next = [...activePointsRef.current, ...points];
      activePointsRef.current = next;
      setActivePoints(next);
    } else {
      setLassoPoints((current) => [...current, ...points.map(([x, y]) => [x, y] as [number, number])]);
    }
  };

  const finishStroke = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (selectionGestureRef.current?.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      selectionGestureRef.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      saveStrokes(strokesRef.current);
      return;
    }
    if (activePointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    cancelStylusHold(event.pointerId);
    activePointerRef.current = undefined;

    if (temporaryEraserPointerRef.current === event.pointerId) {
      temporaryEraserPointerRef.current = undefined;
      setTemporaryEraser(false);
      if (eraserChangedRef.current) {
        saveStrokes(strokesRef.current);
      }
      eraserChangedRef.current = false;
      return;
    }

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

  const beginSelectionGesture = (mode: SelectionGesture['mode'], event: ReactPointerEvent<SVGElement>): void => {
    if (!selectionBounds || event.button !== 0 || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const [startX, startY] = canvasCoordinates(event.clientX, event.clientY);
    selectionGestureRef.current = {
      bounds: selectionBounds,
      mode,
      originalStrokes: strokesRef.current,
      pointerId: event.pointerId,
      startX,
      startY
    };
    try {
      svgRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic test pointers do not always have an OS pointer to capture.
    }
  };

  const shareSelection = (): void => {
    const selected = strokesRef.current.filter((stroke) => selectedStrokeIds.has(stroke.id));
    if (selected.length > 0) {
      onShareSelection(selected);
    }
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
      <div className={`workspace-drawing__toolbar${toolbarExpanded ? ' is-expanded' : ' is-collapsed'}`} onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="workspace-drawing__toolbar-toggle"
          title={toolbarExpanded ? text.hideDrawingToolbar : text.showDrawingToolbar}
          aria-label={toolbarExpanded ? text.hideDrawingToolbar : text.showDrawingToolbar}
          aria-expanded={toolbarExpanded}
          onClick={() => setToolbarExpanded((value) => !value)}
        >
          {toolbarExpanded ? <ChevronUp size={15} /> : <SlidersHorizontal size={15} />}
        </button>
        <div className="workspace-drawing__toolbar-controls">
          <button type="button" className={tool === 'pen' ? 'is-active' : ''} title={text.penTool} aria-label={text.penTool} onClick={() => setTool('pen')}>
            <PenLine size={15} />
          </button>
          <button type="button" className={tool === 'lasso' ? 'is-active' : ''} title={text.lassoTool} aria-label={text.lassoTool} onClick={() => setTool('lasso')}>
            <CircleDashed size={15} />
          </button>
          <button type="button" className={penOnly ? 'is-active' : ''} title={text.penOnlyMode} aria-label={text.penOnlyMode} aria-pressed={penOnly} onClick={() => savePenOnly(!penOnly)}>
            <PenTool size={15} />
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
          {showPlacementControl && (
            <button
              type="button"
              title={canMoveSide ? (payload.side === 'left' ? text.moveCanvasToRight : text.moveCanvasToLeft) : text.canvasSideOccupied}
              aria-label={payload.side === 'left' ? text.moveCanvasToRight : text.moveCanvasToLeft}
              disabled={!canMoveSide}
              onClick={onMoveSide}
            >
              <ArrowLeftRight size={15} />
            </button>
          )}
          <button type="button" title={text.undoStroke} aria-label={text.undoStroke} disabled={strokes.length === 0} onClick={() => saveStrokes(strokes.slice(0, -1))}>
            <Undo2 size={15} />
          </button>
          <button type="button" title={text.deleteSelection} aria-label={text.deleteSelection} disabled={selectedStrokeIds.size === 0} onClick={removeSelection}>
            <Trash2 size={15} />
          </button>
          <button type="button" title={text.clearCanvas} aria-label={text.clearCanvas} disabled={strokes.length === 0} onClick={() => saveStrokes([])}>
            <X size={15} />
          </button>
        </div>
      </div>
      {selectionBounds && (
        <div
          className="workspace-drawing__selection-actions"
          style={{
            left: `${clamp(selectionBounds.x / payload.canvasWidth * 100, 0, 82)}%`,
            top: `${clamp(selectionBounds.y / payload.canvasHeight * 100, 0, 88)}%`
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span>{selectedStrokeIds.size}</span>
          <button type="button" title={text.sendSelectionToAi} aria-label={text.sendSelectionToAi} onClick={shareSelection}><ImagePlus size={13} />{text.sendSelectionToAi}</button>
          <button type="button" className="is-danger" title={text.deleteSelection} aria-label={text.deleteSelection} onClick={removeSelection}><Trash2 size={13} /></button>
        </div>
      )}
      <svg
        ref={svgRef}
        className={`workspace-drawing__surface is-${temporaryEraser ? 'eraser' : tool}${penOnly ? ' is-pen-only' : ''}`}
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
        {selectionBounds && (
          <g className="workspace-drawing__selection">
            <rect
              className="workspace-drawing__selection-box"
              x={selectionBounds.x}
              y={selectionBounds.y}
              width={selectionBounds.width}
              height={selectionBounds.height}
              aria-label={text.moveSelection}
              onPointerDown={(event) => beginSelectionGesture('move', event)}
            />
            <g
              className="workspace-drawing__selection-handle"
              aria-label={text.resizeSelection}
              transform={`translate(${selectionBounds.x + selectionBounds.width} ${selectionBounds.y + selectionBounds.height})`}
              onPointerDown={(event) => beginSelectionGesture('resize', event)}
            >
              <circle r="10" />
              <Maximize2 x={-6} y={-6} width="12" height="12" />
            </g>
          </g>
        )}
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
    penOnly: block.payload?.penOnly === true,
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
