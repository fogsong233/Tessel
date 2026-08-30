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
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Eraser,
  Hand,
  LocateFixed,
  Maximize2,
  Minus,
  PenLine,
  Plus,
  Redo2,
  Slash,
  Star,
  Trash2,
  Undo2
} from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingPoint, LanDrawingStroke, LanWhiteboardClientMessage } from '../../../shared/lanWhiteboard';
import {
  drawingSelectionBounds,
  drawingStrokeNearPoint,
  strokeIntersectsPolygon,
  transformDrawingSelection,
  type DrawingBounds
} from '../drawing/drawingGeometry';
import { DrawingStrokePath } from '../drawing/DrawingStrokePath';
import { createStylusPressureState, normalizeStylusPressure, type StylusPressureState } from '../reader/drawingPressure';
import { remoteDrawingPayload } from './remoteDrawing';

type DrawingTool = 'pen' | 'eraser' | 'lasso' | 'hand';

interface RemoteCanvasProps {
  block: WorkspaceBlock;
  canMove: boolean;
  canNavigateNext: boolean;
  canNavigatePrevious: boolean;
  connected: boolean;
  entryDirection?: 'next' | 'previous';
  sheetNumber: number;
  totalSheets: number;
  remoteStrokes: LanDrawingStroke[];
  send(message: LanWhiteboardClientMessage): boolean;
  onDelete(): void;
  onMove(): void;
  onNavigate(direction: 'next' | 'previous'): void;
}

interface PanState {
  clientX: number;
  clientY: number;
  pointerId: number;
  scrollLeft: number;
  scrollTop: number;
}

interface PageSwipeState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
}

interface PinchState {
  distance: number;
  midpointX: number;
  midpointY: number;
  scrollLeft: number;
  scrollTop: number;
  zoom: number;
}

interface SelectionGesture {
  bounds: DrawingBounds;
  mode: 'move' | 'resize';
  originalStrokes: LanDrawingStroke[];
  pointerId: number;
  startX: number;
  startY: number;
}

interface FavoriteBrush {
  color: string;
  follow: number;
  size: number;
  smoothing: number;
}

const colors = ['#171a16', '#2563eb', '#e0453b', '#16a36a', '#8b4bd6', '#e99620'];
const canvasPadding = 56;
const brushSettingsKey = 'tessel.lan-whiteboard.brush';
const favoriteBrushesKey = 'tessel.lan-whiteboard.favorite-brushes';

export function RemoteCanvas({
  block,
  canMove,
  canNavigateNext,
  canNavigatePrevious,
  connected,
  entryDirection,
  sheetNumber,
  totalSheets,
  remoteStrokes,
  send,
  onDelete,
  onMove,
  onNavigate
}: RemoteCanvasProps): ReactElement {
  const payload = remoteDrawingPayload(block);
  const initialBrushRef = useRef(readStoredBrush());
  const [strokes, setStrokes] = useState(payload.strokes);
  const strokesRef = useRef(payload.strokes);
  const [activeStroke, setActiveStroke] = useState<LanDrawingStroke>();
  const activeStrokeRef = useRef<LanDrawingStroke>();
  const [lassoPoints, setLassoPoints] = useState<Array<[number, number]>>([]);
  const lassoPointsRef = useRef<Array<[number, number]>>([]);
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [color, setColor] = useState(initialBrushRef.current.color);
  const [size, setSize] = useState(initialBrushRef.current.size);
  const [smoothing, setSmoothing] = useState(initialBrushRef.current.smoothing);
  const [follow, setFollow] = useState(initialBrushRef.current.follow);
  const [favoriteBrushes, setFavoriteBrushes] = useState<FavoriteBrush[]>(readFavoriteBrushes);
  const [brushPanelOpen, setBrushPanelOpen] = useState(false);
  const [penOnly, setPenOnly] = useState(payload.penOnly);
  const [zoom, setZoom] = useState(1);
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const [temporaryEraser, setTemporaryEraser] = useState(false);
  const [pageSwipeOffset, setPageSwipeOffset] = useState(0);
  const pageSwipeOffsetRef = useRef(0);
  const zoomRef = useRef(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const activePointerRef = useRef<number>();
  const activePointerTypeRef = useRef<string>();
  const pressureStateRef = useRef<StylusPressureState>(createStylusPressureState());
  const pendingTransmissionRef = useRef<LanDrawingPoint[]>([]);
  const frameRef = useRef<number>();
  const panRef = useRef<PanState>();
  const pageSwipeRef = useRef<PageSwipeState>();
  const wheelNavigationRef = useRef({ accumulated: 0, lastEventAt: 0, lastNavigationAt: 0 });
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState>();
  const eraserChangedRef = useRef(false);
  const stylusHoldRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    strokeId: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const temporaryEraserPointerRef = useRef<number>();
  const undoRef = useRef<LanDrawingStroke[][]>([]);
  const redoRef = useRef<LanDrawingStroke[][]>([]);
  const selectionGestureRef = useRef<SelectionGesture>();
  const deferredFitRef = useRef(false);

  useEffect(() => {
    if (activePointerRef.current === undefined) {
      strokesRef.current = payload.strokes;
      setStrokes(payload.strokes);
      setPenOnly(payload.penOnly);
    }
  }, [block.updatedAt]);

  useEffect(() => {
    localStorage.setItem(brushSettingsKey, JSON.stringify({ color, follow, size, smoothing } satisfies FavoriteBrush));
  }, [color, follow, size, smoothing]);

  useEffect(() => {
    localStorage.setItem(favoriteBrushesKey, JSON.stringify(favoriteBrushes));
  }, [favoriteBrushes]);

  const selectionBounds = drawingSelectionBounds(strokes, selectedStrokeIds);

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
    if (stylusHoldRef.current) {
      clearTimeout(stylusHoldRef.current.timer);
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

  const cancelStylusHold = (pointerId?: number): void => {
    const hold = stylusHoldRef.current;
    if (!hold || (pointerId !== undefined && hold.pointerId !== pointerId)) {
      return;
    }
    clearTimeout(hold.timer);
    stylusHoldRef.current = undefined;
  };

  const updatePageSwipeOffset = (offset: number): void => {
    pageSwipeOffsetRef.current = offset;
    setPageSwipeOffset(offset);
  };

  const eraseAt = (point: LanDrawingPoint): void => {
    const next = strokesRef.current.filter((stroke) => !drawingStrokeNearPoint(stroke, point, Math.max(8, size * 1.8)));
    if (next.length !== strokesRef.current.length) {
      eraserChangedRef.current = true;
      strokesRef.current = next;
      setStrokes(next);
    }
  };

  const armStylusEraser = (event: ReactPointerEvent<SVGSVGElement>, stroke: LanDrawingStroke, point: LanDrawingPoint): void => {
    if (event.pointerType !== 'pen') {
      return;
    }
    const pointerId = event.pointerId;
    const timer = setTimeout(() => {
      if (activePointerRef.current !== pointerId || activeStrokeRef.current?.id !== stroke.id) {
        return;
      }
      stylusHoldRef.current = undefined;
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
      pendingTransmissionRef.current = [];
      send({ type: 'stroke-cancel', canvasId: block.id, strokeId: stroke.id });
      activeStrokeRef.current = undefined;
      setActiveStroke(undefined);
      undoRef.current.push(strokesRef.current);
      redoRef.current = [];
      eraserChangedRef.current = false;
      temporaryEraserPointerRef.current = pointerId;
      setTemporaryEraser(true);
      eraseAt(point);
      navigator.vibrate?.(12);
    }, 480);
    stylusHoldRef.current = {
      pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      strokeId: stroke.id,
      timer
    };
  };

  const cancelActive = (): void => {
    cancelStylusHold();
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
    temporaryEraserPointerRef.current = undefined;
    setTemporaryEraser(false);
    pageSwipeRef.current = undefined;
    updatePageSwipeOffset(0);
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
    if (tool === 'pen' && event.pointerType === 'pen' && activePointerTypeRef.current === 'touch') {
      cancelActive();
      touchPointsRef.current.clear();
      pinchRef.current = undefined;
    }
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
    if (tool === 'pen' && penOnly && event.pointerType === 'touch') {
      event.preventDefault();
      capturePointer(event);
      activePointerRef.current = event.pointerId;
      activePointerTypeRef.current = event.pointerType;
      const viewport = viewportRef.current;
      if (viewport) {
        panRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop
        };
        pageSwipeRef.current = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY
        };
      }
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
        if (event.pointerType === 'touch') {
          pageSwipeRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY
          };
        }
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
        smoothing,
        streamline: 1 - follow,
        points: [point],
        simulatePressure,
        createdAt: new Date().toISOString()
      };
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
      setSelectedStrokeIds(new Set());
      send({ type: 'stroke-begin', canvasId: block.id, stroke });
      armStylusEraser(event, stroke, point);
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

  const moveInteraction = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchRef.current && touchPointsRef.current.size >= 2) {
        event.preventDefault();
        updatePinch();
        return;
      }
    }
    const selectionGesture = selectionGestureRef.current;
    if (selectionGesture?.pointerId === event.pointerId) {
      event.preventDefault();
      const [x, y] = canvasPoint(event.clientX, event.clientY, 0.5, true);
      if (selectionGesture.mode === 'move') {
        const next = transformDrawingSelection(selectionGesture.originalStrokes, selectedStrokeIds, {
          originX: selectionGesture.bounds.x,
          originY: selectionGesture.bounds.y,
          scale: 1,
          translateX: clamp(
            x - selectionGesture.startX,
            -selectionGesture.bounds.x,
            payload.canvasWidth - selectionGesture.bounds.x - selectionGesture.bounds.width
          ),
          translateY: clamp(
            y - selectionGesture.startY,
            -selectionGesture.bounds.y,
            payload.canvasHeight - selectionGesture.bounds.y - selectionGesture.bounds.height
          )
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
        const next = transformDrawingSelection(selectionGesture.originalStrokes, selectedStrokeIds, {
          originX: selectionGesture.bounds.x,
          originY: selectionGesture.bounds.y,
          scale: clamp(Math.max(scaleX, scaleY), 0.2, maximumScale),
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
    const hold = stylusHoldRef.current;
    if (hold?.pointerId === event.pointerId
      && Math.hypot(event.clientX - hold.startClientX, event.clientY - hold.startClientY) > 8) {
      cancelStylusHold(event.pointerId);
    }
    const pan = panRef.current;
    if ((tool === 'hand' || (tool === 'pen' && penOnly)) && pan?.pointerId === event.pointerId) {
      const viewport = viewportRef.current;
      if (viewport) {
        const deltaX = event.clientX - pan.clientX;
        const deltaY = event.clientY - pan.clientY;
        const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const verticalGesture = Math.abs(deltaY) > Math.abs(deltaX) * 1.15;
        const pullingPrevious = deltaY > 0 && pan.scrollTop <= 1 && canNavigatePrevious;
        const pullingNext = deltaY < 0 && pan.scrollTop >= maximumScrollTop - 1 && canNavigateNext;
        if (pageSwipeRef.current?.pointerId === event.pointerId && verticalGesture && (pullingPrevious || pullingNext)) {
          updatePageSwipeOffset(clamp(deltaY * 0.48, -76, 76));
        } else {
          updatePageSwipeOffset(0);
          viewport.scrollLeft = pan.scrollLeft - deltaX;
          viewport.scrollTop = pan.scrollTop - deltaY;
        }
      }
      return;
    }

    const simulatePressure = event.pointerType !== 'pen';
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];
    const points = samples.map((sample) => canvasPoint(sample.clientX, sample.clientY, sample.pressure, simulatePressure));
    if (temporaryEraserPointerRef.current === event.pointerId) {
      for (const point of points) {
        eraseAt(point);
      }
      return;
    }
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
    const selectionGesture = selectionGestureRef.current;
    if (selectionGesture?.pointerId === event.pointerId) {
      event.preventDefault();
      releasePointer(event);
      selectionGestureRef.current = undefined;
      undoRef.current.push(selectionGesture.originalStrokes);
      redoRef.current = [];
      replaceStrokes(strokesRef.current, false);
      finishDeferredFit();
      return;
    }
    if (activePointerRef.current !== event.pointerId) {
      releasePointer(event);
      return;
    }
    event.preventDefault();
    releasePointer(event);
    cancelStylusHold(event.pointerId);
    const pageSwipe = pageSwipeRef.current?.pointerId === event.pointerId
      ? pageSwipeRef.current
      : undefined;
    const completedPageSwipe = event.type === 'pointerup' && pageSwipe && Math.abs(pageSwipeOffsetRef.current) >= 48
      ? pageSwipeOffsetRef.current < 0 ? 'next' : 'previous'
      : undefined;
    pageSwipeRef.current = undefined;
    updatePageSwipeOffset(0);
    activePointerRef.current = undefined;
    activePointerTypeRef.current = undefined;
    panRef.current = undefined;

    if (completedPageSwipe) {
      onNavigate(completedPageSwipe);
      return;
    }

    if (temporaryEraserPointerRef.current === event.pointerId) {
      temporaryEraserPointerRef.current = undefined;
      setTemporaryEraser(false);
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
      eraserChangedRef.current = false;
    } else if (tool === 'pen') {
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
    finishDeferredFit();
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
    const paper = svgRef.current;
    if (!viewport || !paper) {
      return;
    }
    const bounded = clamp(nextZoom, 0.16, 4);
    const viewportRect = viewport.getBoundingClientRect();
    const paperRect = paper.getBoundingClientRect();
    const anchorClientX = clientX ?? viewportRect.left + viewportRect.width / 2;
    const anchorClientY = clientY ?? viewportRect.top + viewportRect.height / 2;
    const anchorX = clamp((anchorClientX - paperRect.left) / Math.max(1, paperRect.width), 0, 1);
    const anchorY = clamp((anchorClientY - paperRect.top) / Math.max(1, paperRect.height), 0, 1);
    zoomRef.current = bounded;
    setZoom(bounded);
    requestAnimationFrame(() => {
      const nextPaperRect = paper.getBoundingClientRect();
      viewport.scrollLeft += nextPaperRect.left + nextPaperRect.width * anchorX - anchorClientX;
      viewport.scrollTop += nextPaperRect.top + nextPaperRect.height * anchorY - anchorClientY;
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

  const finishDeferredFit = (): void => {
    if (!deferredFitRef.current) {
      return;
    }
    deferredFitRef.current = false;
    requestAnimationFrame(fitCanvas);
  };

  useEffect(() => {
    fitCanvas();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (activePointerRef.current !== undefined || selectionGestureRef.current) {
        deferredFitRef.current = true;
        return;
      }
      fitCanvas();
    });
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

  const beginSelectionGesture = (mode: SelectionGesture['mode'], event: ReactPointerEvent<SVGElement>): void => {
    if (!selectionBounds || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const [startX, startY] = canvasPoint(event.clientX, event.clientY, 0.5, true);
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

  const togglePenOnly = (): void => {
    const next = !penOnly;
    setPenOnly(next);
    send({ type: 'set-pen-only', requestId: createRemoteId('pen-only'), canvasId: block.id, penOnly: next });
  };

  const currentBrush = { color, follow, size, smoothing };
  const currentBrushFavorite = favoriteBrushes.some((brush) => sameBrush(brush, currentBrush));

  const toggleFavoriteBrush = (): void => {
    const brush = currentBrush;
    setFavoriteBrushes((current) => current.some((candidate) => sameBrush(candidate, brush))
      ? current.filter((candidate) => !sameBrush(candidate, brush))
      : [...current, brush].slice(-6));
  };

  const selectBrush = (brush: FavoriteBrush): void => {
    setColor(brush.color);
    setSize(brush.size);
    setSmoothing(brush.smoothing);
    setFollow(brush.follow);
    setTool('pen');
  };

  const adjustBrushSize = (delta: number): void => {
    setSize((current) => clamp(Math.round((current + delta) * 2) / 2, 1, 40));
    setTool('pen');
  };

  const shareSelection = (): void => {
    if (selectedStrokeIds.size === 0 || !connected) {
      return;
    }
    send({
      type: 'share-selection',
      requestId: createRemoteId('share'),
      canvasId: block.id,
      strokes: strokesRef.current.filter((stroke) => selectedStrokeIds.has(stroke.id))
    });
    setSelectionNotice('已放入电脑端 AI 输入框');
    window.setTimeout(() => setSelectionNotice(undefined), 2_200);
  };

  const wheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setZoomAround(zoomRef.current * Math.exp(-event.deltaY * 0.0024), event.clientX, event.clientY);
      return;
    }
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const direction = event.deltaY > 0 ? 'next' : 'previous';
    const atBoundary = direction === 'next'
      ? viewport.scrollTop >= maximumScrollTop - 1 && canNavigateNext
      : viewport.scrollTop <= 1 && canNavigatePrevious;
    if (!atBoundary) {
      wheelNavigationRef.current.accumulated = 0;
      return;
    }
    event.preventDefault();
    const now = performance.now();
    const state = wheelNavigationRef.current;
    if (now - state.lastEventAt > 240 || Math.sign(state.accumulated) !== Math.sign(event.deltaY)) {
      state.accumulated = 0;
    }
    state.lastEventAt = now;
    state.accumulated += event.deltaY;
    if (Math.abs(state.accumulated) >= 72 && now - state.lastNavigationAt > 420) {
      state.accumulated = 0;
      state.lastNavigationAt = now;
      onNavigate(direction);
    }
  };

  return (
    <section className={`remote-canvas${entryDirection ? ` is-entering-${entryDirection}` : ''}`}>
      <div className="remote-tools" aria-label="手写工具栏">
        <ToolButton active={tool === 'pen' && !temporaryEraser} pressed={brushPanelOpen} label="画笔设置" onClick={() => { setTool('pen'); setBrushPanelOpen((value) => !value); }}>
          <span className="remote-pen-tool-icon"><PenLine /><i style={{ background: color }} /></span>
        </ToolButton>
        <ToolButton active={tool === 'eraser' || temporaryEraser} label="橡皮" onClick={() => { setTool('eraser'); setBrushPanelOpen(false); }}><Eraser /></ToolButton>
        <ToolButton active={tool === 'lasso'} label="圈选" onClick={() => { setTool('lasso'); setBrushPanelOpen(false); }}><CircleDashed /></ToolButton>
        <ToolButton active={tool === 'hand'} label="移动" onClick={() => { setTool('hand'); setBrushPanelOpen(false); }}><Hand /></ToolButton>
        <ToolButton active={penOnly} pressed={penOnly} label={penOnly ? '已禁用手指书写' : '禁用手指书写'} onClick={togglePenOnly}>
          <span className="remote-touch-block-icon"><Hand /><Slash /></span>
        </ToolButton>
        <span className="remote-tools__divider" />
        <section className={`remote-brush-panel${brushPanelOpen ? ' is-open' : ''}`} aria-label="画笔设置" aria-hidden={!brushPanelOpen}>
          <header>
            <strong>画笔</strong>
            <small>调节后仅影响新笔迹</small>
          </header>
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
        <span className="remote-tools__divider" />
        <ToolButton active={currentBrushFavorite} pressed={currentBrushFavorite} label={currentBrushFavorite ? '取消收藏当前笔刷' : '收藏当前笔刷'} onClick={toggleFavoriteBrush}>
          <Star fill={currentBrushFavorite ? 'currentColor' : 'none'} />
        </ToolButton>
        {favoriteBrushes.length > 0 && (
          <div className="remote-brush-favorites" aria-label="收藏的笔刷">
            {favoriteBrushes.map((brush) => (
              <button
                type="button"
                key={`${brush.color}-${brush.size}`}
                className={sameBrush(brush, currentBrush) ? 'is-active' : undefined}
                aria-label={`使用收藏笔刷 ${brush.color} ${formatBrushSize(brush.size)} 像素`}
                title={`${brush.color} · ${formatBrushSize(brush.size)} px`}
                onClick={() => selectBrush(brush)}
              >
                <span style={{ background: brush.color, height: clamp(brush.size / 2, 2, 12) }} />
              </button>
            ))}
          </div>
        )}
        <div className="remote-size" title={`笔触 ${formatBrushSize(size)}px`}>
          <span style={{ width: clamp(size, 3, 22), height: clamp(size, 3, 22) }} />
          <button type="button" aria-label="减小笔刷宽度" onClick={() => adjustBrushSize(-1)}><Minus /></button>
          <input type="range" min="1" max="40" step="0.5" value={size} aria-label="笔刷宽度" onChange={(event) => { setSize(Number(event.target.value)); setTool('pen'); }} />
          <button type="button" aria-label="增大笔刷宽度" onClick={() => adjustBrushSize(1)}><Plus /></button>
          <output>{formatBrushSize(size)}</output>
        </div>
          <label className="remote-brush-tuning">
            <span><strong>跟手</strong><output>{Math.round(follow * 100)}</output></span>
            <input type="range" min="0" max="100" step="1" value={Math.round(follow * 100)} aria-label="笔触跟手程度" onChange={(event) => setFollow(Number(event.target.value) / 100)} />
          </label>
          <label className="remote-brush-tuning">
            <span><strong>平滑</strong><output>{Math.round(smoothing * 100)}</output></span>
            <input type="range" min="0" max="100" step="1" value={Math.round(smoothing * 100)} aria-label="笔触平滑程度" onChange={(event) => setSmoothing(Number(event.target.value) / 100)} />
          </label>
        </section>
        <span className="remote-tools__spacer" />
        <ToolButton disabled={undoRef.current.length === 0 && strokes.length === 0} label="撤销" onClick={undo}><Undo2 /></ToolButton>
        <ToolButton disabled={redoRef.current.length === 0} label="重做" onClick={redo}><Redo2 /></ToolButton>
      </div>

      <div className="remote-canvas__viewport" ref={viewportRef} onWheel={wheel}>
        <div
          className={`remote-canvas__space${pageSwipeOffset ? ' is-page-swiping' : ''}`}
          style={{
            width: payload.canvasWidth * zoom + canvasPadding * 2,
            height: payload.canvasHeight * zoom + canvasPadding * 2
          }}
        >
          <div
            className="remote-canvas__stage"
            style={{
              width: payload.canvasWidth * zoom,
              height: payload.canvasHeight * zoom,
              transform: `translateY(${pageSwipeOffset}px)`
            }}
          >
            <svg
              ref={svgRef}
              className={`remote-canvas__paper is-${temporaryEraser ? 'eraser' : tool}`}
              viewBox={`0 0 ${payload.canvasWidth} ${payload.canvasHeight}`}
              preserveAspectRatio="none"
              onPointerDown={startInteraction}
              onPointerMove={moveInteraction}
              onPointerUp={finishInteraction}
              onPointerCancel={finishInteraction}
            >
              <rect width={payload.canvasWidth} height={payload.canvasHeight} fill="#fff" />
              {strokes.map((stroke) => (
                <DrawingStrokePath
                  key={stroke.id}
                  className={selectedStrokeIds.has(stroke.id) ? 'is-selected' : undefined}
                  stroke={stroke}
                />
              ))}
              {remoteStrokes.map((stroke) => <DrawingStrokePath key={`remote-${stroke.id}`} active stroke={stroke} opacity={0.78} />)}
              {activeStroke && <DrawingStrokePath active stroke={activeStroke} />}
              {lassoPoints.length > 1 && <polyline className="remote-canvas__lasso" points={lassoPoints.map((point) => point.join(',')).join(' ')} />}
              {selectionBounds && (
                <g className="remote-canvas__selection">
                  <rect
                    className="remote-canvas__selection-box"
                    x={selectionBounds.x}
                    y={selectionBounds.y}
                    width={selectionBounds.width}
                    height={selectionBounds.height}
                    aria-label="移动选区"
                    onPointerDown={(event) => beginSelectionGesture('move', event)}
                  />
                  <g
                    className="remote-canvas__selection-handle"
                    aria-label="缩放选区"
                    transform={`translate(${selectionBounds.x + selectionBounds.width} ${selectionBounds.y + selectionBounds.height})`}
                    onPointerDown={(event) => beginSelectionGesture('resize', event)}
                  >
                    <circle r="11" />
                    <Maximize2 x={-6} y={-6} width="12" height="12" />
                  </g>
                </g>
              )}
            </svg>
            {selectionBounds && (
              <div
                className="remote-selection-actions"
                style={{
                  left: (selectionBounds.x + 7) * zoom,
                  top: (selectionBounds.y + 7) * zoom
                }}
              >
                <span>{selectedStrokeIds.size} 条</span>
                <button type="button" disabled={!connected} onClick={shareSelection}>发送到 AI</button>
                <button type="button" className="is-danger" onClick={deleteSelection}>删除</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {totalSheets > 1 && (
        <nav className="remote-page-flow" aria-label="同页纸张导航">
          <button type="button" aria-label="上一张纸" disabled={!canNavigatePrevious} onClick={() => onNavigate('previous')}><ChevronUp /></button>
          <span><strong>{sheetNumber}</strong><small>/{totalSheets}</small></span>
          <button type="button" aria-label="下一张纸" disabled={!canNavigateNext} onClick={() => onNavigate('next')}><ChevronDown /></button>
        </nav>
      )}

      <div className="remote-canvas__identity">
        <span><strong>PDF {block.pageNumber ?? '—'} · 纸张 {sheetNumber}/{totalSheets}</strong></span>
        <button type="button" disabled={!canMove} title={`把笔记窗口移到${payload.side === 'left' ? '右' : '左'}侧`} onClick={onMove}><ArrowLeftRight />换侧</button>
        <button type="button" className="is-danger" title="删除这张纸" onClick={onDelete}><Trash2 />删除</button>
      </div>

      <div className="remote-zoom">
        <button type="button" aria-label="缩小" onClick={() => setZoomAround(zoomRef.current / 1.18)}><Minus /></button>
        <button type="button" className="remote-zoom__value" onClick={fitCanvas}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="放大" onClick={() => setZoomAround(zoomRef.current * 1.18)}><Plus /></button>
        <button type="button" aria-label="适合屏幕" onClick={fitCanvas}><LocateFixed /></button>
      </div>
      {!connected && <div className="remote-canvas__offline">正在重新连接，笔迹会在连接恢复后继续同步</div>}
      {selectionNotice && <div className="remote-canvas__notice" role="status">{selectionNotice}</div>}
    </section>
  );
}

function ToolButton({
  active = false,
  children,
  danger = false,
  disabled = false,
  label,
  onClick,
  pressed
}: {
  active?: boolean;
  children: ReactElement;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onClick(): void;
  pressed?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`remote-tool${active ? ' is-active' : ''}${danger ? ' is-danger' : ''}`}
      aria-label={label}
      aria-pressed={pressed}
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

function readStoredBrush(): FavoriteBrush {
  try {
    return normalizeBrush(JSON.parse(localStorage.getItem(brushSettingsKey) ?? 'null')) ?? defaultBrush();
  } catch {
    return defaultBrush();
  }
}

function readFavoriteBrushes(): FavoriteBrush[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(favoriteBrushesKey) ?? '[]');
    return Array.isArray(parsed) ? parsed.flatMap((value) => normalizeBrush(value) ?? []).slice(-6) : [];
  } catch {
    return [];
  }
}

function normalizeBrush(value: unknown): FavoriteBrush | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const brush = value as Partial<FavoriteBrush>;
  return typeof brush.color === 'string' && /^#[0-9a-f]{6}$/i.test(brush.color)
    && typeof brush.size === 'number' && Number.isFinite(brush.size)
    ? {
        color: brush.color.toLowerCase(),
        follow: unitInterval(brush.follow, 0.9),
        size: clamp(Math.round(brush.size * 2) / 2, 1, 40),
        smoothing: unitInterval(brush.smoothing, 0.5)
      }
    : undefined;
}

function sameBrush(left: FavoriteBrush, right: FavoriteBrush): boolean {
  return left.color.toLowerCase() === right.color.toLowerCase()
    && Math.abs(left.size - right.size) < 0.01
    && Math.abs(left.follow - right.follow) < 0.01
    && Math.abs(left.smoothing - right.smoothing) < 0.01;
}

function defaultBrush(): FavoriteBrush {
  return { color: colors[0], follow: 0.9, size: 4, smoothing: 0.5 };
}

function unitInterval(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
}

function formatBrushSize(size: number): string {
  return Number.isInteger(size) ? String(size) : size.toFixed(1);
}
