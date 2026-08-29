import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import {
  CircleDashed,
  Eraser,
  Hand,
  LocateFixed,
  Minus,
  PenLine,
  Plus,
  Redo2,
  Trash2,
  Undo2
} from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingPoint, LanDrawingStroke, LanWhiteboardClientMessage } from '../../../shared/lanWhiteboard';
import { createStylusPressureState, normalizeStylusPressure, type StylusPressureState } from '../reader/drawingPressure';
import { drawingStrokePath, remoteDrawingPayload, strokeIntersectsPolygon, strokeNearPoint } from './remoteDrawing';

type DrawingTool = 'pen' | 'eraser' | 'lasso' | 'hand';

interface RemoteCanvasProps {
  block: WorkspaceBlock;
  connected: boolean;
  remoteStrokes: LanDrawingStroke[];
  send(message: LanWhiteboardClientMessage): boolean;
}

interface PanState {
  clientX: number;
  clientY: number;
  pointerId: number;
  scrollLeft: number;
  scrollTop: number;
}

interface PinchState {
  distance: number;
  midpointX: number;
  midpointY: number;
  scrollLeft: number;
  scrollTop: number;
  zoom: number;
}

const colors = ['#171a16', '#2563eb', '#e0453b', '#16a36a', '#8b4bd6', '#e99620'];
const canvasPadding = 56;

export function RemoteCanvas({ block, connected, remoteStrokes, send }: RemoteCanvasProps): ReactElement {
  const payload = remoteDrawingPayload(block);
  const [strokes, setStrokes] = useState(payload.strokes);
  const strokesRef = useRef(payload.strokes);
  const [activeStroke, setActiveStroke] = useState<LanDrawingStroke>();
  const activeStrokeRef = useRef<LanDrawingStroke>();
  const [lassoPoints, setLassoPoints] = useState<Array<[number, number]>>([]);
  const lassoPointsRef = useRef<Array<[number, number]>>([]);
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [color, setColor] = useState(colors[0]);
  const [size, setSize] = useState(4);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const activePointerRef = useRef<number>();
  const activePointerTypeRef = useRef<string>();
  const pressureStateRef = useRef<StylusPressureState>(createStylusPressureState());
  const pendingTransmissionRef = useRef<LanDrawingPoint[]>([]);
  const frameRef = useRef<number>();
  const panRef = useRef<PanState>();
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState>();
  const eraserChangedRef = useRef(false);
  const undoRef = useRef<LanDrawingStroke[][]>([]);
  const redoRef = useRef<LanDrawingStroke[][]>([]);

  useEffect(() => {
    if (activePointerRef.current === undefined) {
      strokesRef.current = payload.strokes;
      setStrokes(payload.strokes);
    }
  }, [block.updatedAt]);

  const applyStrokes = useCallback((next: LanDrawingStroke[], remember = true): void => {
    if (remember) {
      undoRef.current.push(strokesRef.current);
      if (undoRef.current.length > 80) {
        undoRef.current.shift();
      }
      redoRef.current = [];
    }
    strokesRef.current = next;
    setStrokes(next);
  }, []);

  const replaceStrokes = useCallback((next: LanDrawingStroke[], remember = true): void => {
    applyStrokes(next, remember);
    send({
      type: 'replace-strokes',
      requestId: createRemoteId('replace'),
      canvasId: block.id,
      strokes: next
    });
  }, [applyStrokes, block.id, send]);

  const flushFrame = useCallback((): void => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }
    const stroke = activeStrokeRef.current;
    if (stroke) {
      setActiveStroke({ ...stroke, points: [...stroke.points] });
    }
    const points = pendingTransmissionRef.current;
    pendingTransmissionRef.current = [];
    if (stroke && points.length > 0) {
      send({ type: 'stroke-points', canvasId: block.id, strokeId: stroke.id, points });
    }
  }, [block.id, send]);

  const scheduleFrame = useCallback((): void => {
    if (frameRef.current === undefined) {
      frameRef.current = requestAnimationFrame(flushFrame);
    }
  }, [flushFrame]);

  useEffect(() => () => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
    }
  }, []);

  const canvasPoint = (clientX: number, clientY: number, pressure: number, simulatePressure: boolean): LanDrawingPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) {
      return [0, 0, 0.5];
    }
    const resolvedPressure = simulatePressure ? 0.5 : normalizeStylusPressure(pressure, pressureStateRef.current);
    return [
      clamp((clientX - rect.left) * payload.canvasWidth / rect.width, 0, payload.canvasWidth),
      clamp((clientY - rect.top) * payload.canvasHeight / rect.height, 0, payload.canvasHeight),
      resolvedPressure
    ];
  };

  const cancelActive = (): void => {
    const stroke = activeStrokeRef.current;
    if (stroke) {
      send({ type: 'stroke-cancel', canvasId: block.id, strokeId: stroke.id });
    }
    activeStrokeRef.current = undefined;
    activePointerRef.current = undefined;
    activePointerTypeRef.current = undefined;
    pendingTransmissionRef.current = [];
    setActiveStroke(undefined);
    lassoPointsRef.current = [];
    setLassoPoints([]);
  };

  const beginPinchIfReady = (): boolean => {
    if (touchPointsRef.current.size < 2) {
      return false;
    }
    const viewport = viewportRef.current;
    const [first, second] = [...touchPointsRef.current.values()];
    if (!viewport || !first || !second) {
      return false;
    }
    if (activePointerTypeRef.current !== 'pen') {
      cancelActive();
    }
    pinchRef.current = {
      distance: Math.max(1, distance(first, second)),
      midpointX: (first.x + second.x) / 2,
      midpointY: (first.y + second.y) / 2,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      zoom: zoomRef.current
    };
    return true;
  };

  const startInteraction = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === 'touch') {
      if (activePointerTypeRef.current === 'pen') {
        return;
      }
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      capturePointer(event);
      if (beginPinchIfReady()) {
        event.preventDefault();
        return;
      }
    }
    if (event.button !== 0 || activePointerRef.current !== undefined) {
      return;
    }
    event.preventDefault();
    capturePointer(event);
    activePointerRef.current = event.pointerId;
    activePointerTypeRef.current = event.pointerType;

    if (tool === 'hand') {
      const viewport = viewportRef.current;
      if (viewport) {
        panRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop
        };
      }
      return;
    }

    const simulatePressure = event.pointerType !== 'pen';
    pressureStateRef.current = createStylusPressureState();
    const point = canvasPoint(event.clientX, event.clientY, event.pressure, simulatePressure);
    if (tool === 'pen') {
      const stroke: LanDrawingStroke = {
        id: createRemoteId('stroke'),
        color,
        size,
        points: [point],
        simulatePressure,
        createdAt: new Date().toISOString()
      };
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
      setSelectedStrokeIds(new Set());
      send({ type: 'stroke-begin', canvasId: block.id, stroke });
      return;
    }
    if (tool === 'eraser') {
      undoRef.current.push(strokesRef.current);
      redoRef.current = [];
      eraserChangedRef.current = false;
      eraseAt(point);
      return;
    }
    lassoPointsRef.current = [[point[0], point[1]]];
    setLassoPoints(lassoPointsRef.current);
  };

  const eraseAt = (point: LanDrawingPoint): void => {
    const next = strokesRef.current.filter((stroke) => !strokeNearPoint(stroke, point, Math.max(8, size * 1.8)));
    if (next.length !== strokesRef.current.length) {
      eraserChangedRef.current = true;
      strokesRef.current = next;
      setStrokes(next);
    }
  };

  const moveInteraction = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchRef.current && touchPointsRef.current.size >= 2) {
        event.preventDefault();
        updatePinch();
        return;
      }
    }
    if (activePointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const pan = panRef.current;
    if (tool === 'hand' && pan?.pointerId === event.pointerId) {
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
        viewport.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
      }
      return;
    }

    const simulatePressure = event.pointerType !== 'pen';
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];
    const points = samples.map((sample) => canvasPoint(sample.clientX, sample.clientY, sample.pressure, simulatePressure));
    if (tool === 'pen' && activeStrokeRef.current) {
      activeStrokeRef.current.points.push(...points);
      pendingTransmissionRef.current.push(...points);
      scheduleFrame();
    } else if (tool === 'eraser') {
      for (const point of points) {
        eraseAt(point);
      }
    } else if (tool === 'lasso') {
      lassoPointsRef.current.push(...points.map(([x, y]) => [x, y] as [number, number]));
      setLassoPoints([...lassoPointsRef.current]);
    }
  };

  const finishInteraction = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId);
      if (touchPointsRef.current.size < 2) {
        pinchRef.current = undefined;
      }
    }
    if (activePointerRef.current !== event.pointerId) {
      releasePointer(event);
      return;
    }
    event.preventDefault();
    releasePointer(event);
    activePointerRef.current = undefined;
    activePointerTypeRef.current = undefined;
    panRef.current = undefined;

    if (tool === 'pen') {
      flushFrame();
      const stroke = activeStrokeRef.current;
      if (stroke && stroke.points.length > 0) {
        applyStrokes([...strokesRef.current, stroke]);
        send({ type: 'stroke-commit', requestId: createRemoteId('commit'), canvasId: block.id, stroke });
      }
      activeStrokeRef.current = undefined;
      pendingTransmissionRef.current = [];
      setActiveStroke(undefined);
    } else if (tool === 'eraser') {
      if (eraserChangedRef.current) {
        send({
          type: 'replace-strokes',
          requestId: createRemoteId('erase'),
          canvasId: block.id,
          strokes: strokesRef.current
        });
      } else {
        undoRef.current.pop();
      }
    } else if (tool === 'lasso') {
      const polygon = lassoPointsRef.current;
      setSelectedStrokeIds(new Set(polygon.length >= 3
        ? strokesRef.current.filter((stroke) => strokeIntersectsPolygon(stroke, polygon)).map((stroke) => stroke.id)
        : []));
      lassoPointsRef.current = [];
      setLassoPoints([]);
    }
  };

  const updatePinch = (): void => {
    const viewport = viewportRef.current;
    const pinch = pinchRef.current;
    const [first, second] = [...touchPointsRef.current.values()];
    if (!viewport || !pinch || !first || !second) {
      return;
    }
    const midpointX = (first.x + second.x) / 2;
    const midpointY = (first.y + second.y) / 2;
    const nextZoom = clamp(pinch.zoom * distance(first, second) / pinch.distance, 0.16, 4);
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    viewport.scrollLeft = (pinch.scrollLeft + pinch.midpointX) * nextZoom / pinch.zoom - midpointX;
    viewport.scrollTop = (pinch.scrollTop + pinch.midpointY) * nextZoom / pinch.zoom - midpointY;
  };

  const setZoomAround = (nextZoom: number, clientX?: number, clientY?: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const bounded = clamp(nextZoom, 0.16, 4);
    const oldZoom = zoomRef.current;
    const rect = viewport.getBoundingClientRect();
    const localX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const localY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const contentX = viewport.scrollLeft + localX;
    const contentY = viewport.scrollTop + localY;
    zoomRef.current = bounded;
    setZoom(bounded);
    requestAnimationFrame(() => {
      viewport.scrollLeft = contentX * bounded / oldZoom - localX;
      viewport.scrollTop = contentY * bounded / oldZoom - localY;
    });
  };

  const fitCanvas = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const next = clamp(Math.min(
      (viewport.clientWidth - canvasPadding * 2) / payload.canvasWidth,
      (viewport.clientHeight - canvasPadding * 2) / payload.canvasHeight
    ), 0.16, 2.5);
    zoomRef.current = next;
    setZoom(next);
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, (payload.canvasWidth * next + canvasPadding * 2 - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (payload.canvasHeight * next + canvasPadding * 2 - viewport.clientHeight) / 2);
    });
  }, [payload.canvasHeight, payload.canvasWidth]);

  useEffect(() => {
    fitCanvas();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => fitCanvas());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [block.id, fitCanvas]);

  const undo = (): void => {
    const previous = undoRef.current.pop() ?? (strokesRef.current.length > 0 ? strokesRef.current.slice(0, -1) : undefined);
    if (!previous) {
      return;
    }
    redoRef.current.push(strokesRef.current);
    replaceStrokes(previous, false);
  };

  const redo = (): void => {
    const next = redoRef.current.pop();
    if (!next) {
      return;
    }
    undoRef.current.push(strokesRef.current);
    replaceStrokes(next, false);
  };

  const deleteSelection = (): void => {
    if (selectedStrokeIds.size === 0) {
      return;
    }
    replaceStrokes(strokesRef.current.filter((stroke) => !selectedStrokeIds.has(stroke.id)));
    setSelectedStrokeIds(new Set());
  };

  const wheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setZoomAround(zoomRef.current * Math.exp(-event.deltaY * 0.0024), event.clientX, event.clientY);
    }
  };

  return (
    <section className="remote-canvas">
      <div className="remote-tools" aria-label="手写工具栏">
        <ToolButton active={tool === 'pen'} label="笔" onClick={() => setTool('pen')}><PenLine /></ToolButton>
        <ToolButton active={tool === 'eraser'} label="橡皮" onClick={() => setTool('eraser')}><Eraser /></ToolButton>
        <ToolButton active={tool === 'lasso'} label="圈选" onClick={() => setTool('lasso')}><CircleDashed /></ToolButton>
        <ToolButton active={tool === 'hand'} label="移动" onClick={() => setTool('hand')}><Hand /></ToolButton>
        <span className="remote-tools__divider" />
        <div className="remote-color-row" aria-label="颜色">
          {colors.map((preset) => (
            <button
              type="button"
              key={preset}
              className={`remote-color${color === preset ? ' is-active' : ''}`}
              style={{ '--ink': preset } as CSSProperties}
              aria-label={`颜色 ${preset}`}
              onClick={() => { setColor(preset); setTool('pen'); }}
            />
          ))}
          <label className="remote-color remote-color--custom" style={{ '--ink': color } as CSSProperties}>
            <input type="color" value={color} aria-label="自定义颜色" onChange={(event) => { setColor(event.target.value); setTool('pen'); }} />
          </label>
        </div>
        <label className="remote-size" title={`笔触 ${size}px`}>
          <span style={{ width: clamp(size, 3, 22), height: clamp(size, 3, 22) }} />
          <input type="range" min="1" max="32" value={size} onChange={(event) => setSize(Number(event.target.value))} />
          <output>{size}</output>
        </label>
        <span className="remote-tools__spacer" />
        <ToolButton disabled={strokes.length === 0} label="撤销" onClick={undo}><Undo2 /></ToolButton>
        <ToolButton disabled={redoRef.current.length === 0} label="重做" onClick={redo}><Redo2 /></ToolButton>
        {selectedStrokeIds.size > 0 && <ToolButton danger label={`删除所选 ${selectedStrokeIds.size} 条`} onClick={deleteSelection}><Trash2 /></ToolButton>}
      </div>

      <div className="remote-canvas__viewport" ref={viewportRef} onWheel={wheel}>
        <div
          className="remote-canvas__space"
          style={{
            width: payload.canvasWidth * zoom + canvasPadding * 2,
            height: payload.canvasHeight * zoom + canvasPadding * 2
          }}
        >
          <svg
            ref={svgRef}
            className={`remote-canvas__paper is-${tool}`}
            style={{
              left: canvasPadding,
              top: canvasPadding,
              width: payload.canvasWidth * zoom,
              height: payload.canvasHeight * zoom
            }}
            viewBox={`0 0 ${payload.canvasWidth} ${payload.canvasHeight}`}
            preserveAspectRatio="none"
            onPointerDown={startInteraction}
            onPointerMove={moveInteraction}
            onPointerUp={finishInteraction}
            onPointerCancel={finishInteraction}
          >
            <rect width={payload.canvasWidth} height={payload.canvasHeight} fill="#fff" />
            {strokes.map((stroke) => (
              <path
                key={stroke.id}
                className={selectedStrokeIds.has(stroke.id) ? 'is-selected' : undefined}
                d={drawingStrokePath(stroke)}
                fill={stroke.color}
              />
            ))}
            {remoteStrokes.map((stroke) => <path key={`remote-${stroke.id}`} d={drawingStrokePath(stroke, true)} fill={stroke.color} opacity="0.78" />)}
            {activeStroke && <path d={drawingStrokePath(activeStroke, true)} fill={activeStroke.color} />}
            {lassoPoints.length > 1 && <polyline className="remote-canvas__lasso" points={lassoPoints.map((point) => point.join(',')).join(' ')} />}
          </svg>
        </div>
      </div>

      <div className="remote-zoom">
        <button type="button" aria-label="缩小" onClick={() => setZoomAround(zoomRef.current / 1.18)}><Minus /></button>
        <button type="button" className="remote-zoom__value" onClick={fitCanvas}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="放大" onClick={() => setZoomAround(zoomRef.current * 1.18)}><Plus /></button>
        <button type="button" aria-label="适合屏幕" onClick={fitCanvas}><LocateFixed /></button>
      </div>
      {!connected && <div className="remote-canvas__offline">正在重新连接，笔迹会在连接恢复后继续同步</div>}
    </section>
  );
}

function ToolButton({
  active = false,
  children,
  danger = false,
  disabled = false,
  label,
  onClick
}: {
  active?: boolean;
  children: ReactElement;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onClick(): void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`remote-tool${active ? ' is-active' : ''}${danger ? ' is-danger' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function releasePointer(event: ReactPointerEvent<SVGSVGElement>): void {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}

function capturePointer(event: ReactPointerEvent<SVGSVGElement>): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // A browser may reject capture for synthetic events; normal pen and touch
    // events still take the fast captured-pointer path.
  }
}

function distance(first: { x: number; y: number }, second: { x: number; y: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function createRemoteId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
