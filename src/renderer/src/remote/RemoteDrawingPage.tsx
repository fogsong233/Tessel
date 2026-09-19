import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Maximize2, Send, Trash2, X } from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingPoint, LanDrawingStroke, LanWhiteboardClientMessage } from '../../../shared/lanWhiteboard';
import { DrawingStrokePath } from '../drawing/DrawingStrokePath';
import { drawingSelectionBounds, drawingStrokeNearPoint, strokeIntersectsPolygon, transformDrawingSelection, type DrawingBounds } from '../drawing/drawingGeometry';
import { createStylusPressureState, normalizeStylusPressure } from '../reader/drawingPressure';
import { remoteDrawingPayload } from './remoteDrawing';
import { clamp, RemoteInk, remoteId } from './remoteInk';

export interface RemoteBrush { color: string; size: number; follow: number; smoothing: number }
export type RemoteTool = 'pen' | 'eraser' | 'lasso';
export interface RemotePageHandle { undo(): void; redo(): void; cancel(): void }
interface Props {
  block: WorkspaceBlock;
  brush: RemoteBrush;
  tool: RemoteTool;
  browsing: boolean;
  fingerWriting: boolean;
  active: boolean;
  remoteStrokes?: Record<string, LanDrawingStroke>;
  send(message: LanWhiteboardClientMessage): boolean;
  onActivate(id: string): void;
}
interface Gesture {
  pointerId: number;
  pointerType: string;
  tool: RemoteTool;
  rect: DOMRect;
  before: LanDrawingStroke[];
  stroke?: LanDrawingStroke;
  ink?: RemoteInk;
  sent: number;
  polygon: Array<[number, number]>;
  transform?: { mode: 'move' | 'resize'; bounds: DrawingBounds; x: number; y: number };
}

export const RemoteDrawingPage = memo(forwardRef<RemotePageHandle, Props>(function RemoteDrawingPage({
  block, brush, tool, browsing, fingerWriting, active, remoteStrokes, send, onActivate
}, ref) {
  const payload = useMemo(() => remoteDrawingPayload(block), [block]);
  const [strokes, setStrokes] = useState(payload.strokes);
  const strokesRef = useRef(strokes);
  const latestPayload = useRef(payload);
  latestPayload.current = payload;
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const liveRef = useRef<SVGGElement>(null);
  const lassoRef = useRef<SVGPolylineElement>(null);
  const gesture = useRef<Gesture>();
  const pressure = useRef(createStylusPressureState());
  const frame = useRef<number>();
  const undoStack = useRef<LanDrawingStroke[][]>([]);
  const redoStack = useRef<LanDrawingStroke[][]>([]);
  const bounds = useMemo(() => drawingSelectionBounds(strokes, selection), [strokes, selection]);

  function update(next: LanDrawingStroke[]): void {
    strokesRef.current = next;
    setStrokes(next);
  }
  function remember(previous: LanDrawingStroke[]): void {
    undoStack.current = [...undoStack.current.slice(-79), previous];
    redoStack.current = [];
  }
  function replace(next: LanDrawingStroke[], history = true): void {
    if (history) remember(strokesRef.current);
    update(next);
    send({ type: 'replace-strokes', requestId: remoteId('replace'), canvasId: block.id, strokes: next });
  }

  useEffect(() => {
    if (!gesture.current) update(payload.strokes);
  }, [payload.strokes]);
  useLayoutEffect(() => {
    if (!gesture.current) liveRef.current?.replaceChildren();
  }, [strokes]);
  useEffect(() => {
    if (!active || tool !== 'lasso' || browsing) setSelection(new Set());
  }, [active, tool, browsing]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const notebook = svgRef.current?.closest('.remote-canvas');
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      const current = gesture.current;
      if (current?.stroke) send({ type: 'stroke-cancel', canvasId: block.id, strokeId: current.stroke.id });
      if (current) notebook?.removeAttribute('data-writing');
    };
  }, [block.id, send]);

  function cancel(): void {
    const current = gesture.current;
    if (!current) return;
    if (current.stroke) send({ type: 'stroke-cancel', canvasId: block.id, strokeId: current.stroke.id });
    gesture.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    update(latestPayload.current.strokes);
    liveRef.current?.replaceChildren();
    lassoRef.current?.setAttribute('points', '');
    svgRef.current?.closest('.remote-canvas')?.removeAttribute('data-writing');
  }
  useImperativeHandle(ref, () => ({
    cancel,
    undo() {
      cancel();
      const previous = undoStack.current.pop() ?? (strokesRef.current.length ? strokesRef.current.slice(0, -1) : undefined);
      if (!previous) return;
      redoStack.current.push(strokesRef.current);
      replace(previous, false);
      setSelection(new Set());
    },
    redo() {
      cancel();
      const next = redoStack.current.pop();
      if (!next) return;
      undoStack.current.push(strokesRef.current);
      replace(next, false);
      setSelection(new Set());
    }
  }));

  function point(event: { clientX: number; clientY: number; pressure: number }, current: Gesture): LanDrawingPoint {
    return [
      clamp((event.clientX - current.rect.left) * payload.canvasWidth / current.rect.width, 0, payload.canvasWidth),
      clamp((event.clientY - current.rect.top) * payload.canvasHeight / current.rect.height, 0, payload.canvasHeight),
      current.pointerType === 'pen' ? normalizeStylusPressure(event.pressure, pressure.current) : 0.5
    ];
  }
  function flush(): void {
    frame.current = undefined;
    const current = gesture.current;
    if (!current) return;
    current.ink?.render();
    if (current.stroke && current.sent < current.stroke.points.length) {
      for (let offset = current.sent; offset < current.stroke.points.length; offset += 2048) {
        send({ type: 'stroke-points', canvasId: block.id, strokeId: current.stroke.id, points: current.stroke.points.slice(offset, offset + 2048) });
      }
      current.sent = current.stroke.points.length;
    }
    if (current.tool === 'lasso' && !current.transform) {
      lassoRef.current?.setAttribute('points', current.polygon.map((p) => p.join(',')).join(' '));
    }
  }
  function schedule(): void {
    if (frame.current === undefined) frame.current = requestAnimationFrame(flush);
  }
  function erase(p: LanDrawingPoint): void {
    const previous = strokesRef.current;
    const next = previous.filter((stroke) => !drawingStrokeNearPoint(stroke, p, Math.max(8, brush.size * 2)));
    if (next.length !== previous.length) update(next);
  }

  function start(event: ReactPointerEvent<SVGSVGElement>, transform?: Gesture['transform']): void {
    if (browsing || (event.pointerType === 'touch' && !fingerWriting)) return;
    if (event.pointerType === 'touch' && event.currentTarget.closest('.remote-canvas')?.getAttribute('data-writing') === 'pen') return;
    if (event.button !== 0 && !(event.pointerType === 'pen' && event.button === 5)) return;
    if (gesture.current) {
      if (event.pointerType !== 'pen' || gesture.current.pointerType === 'pen') return;
      cancel();
    }
    event.preventDefault();
    onActivate(block.id);
    pressure.current = createStylusPressureState();
    const current: Gesture = {
      pointerId: event.pointerId, pointerType: event.pointerType,
      tool: event.button === 5 || (event.buttons & 32) !== 0 ? 'eraser' : tool,
      rect: event.currentTarget.getBoundingClientRect(), before: strokesRef.current,
      sent: 1, polygon: [], transform
    };
    gesture.current = current;
    event.currentTarget.closest('.remote-canvas')?.setAttribute('data-writing', event.pointerType);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers have no OS capture. */ }
    const p = point(event, current);
    if (transform) return;
    setSelection(new Set());
    if (current.tool === 'pen') {
      const stroke: LanDrawingStroke = {
        id: remoteId('stroke'), color: brush.color, size: brush.size,
        smoothing: brush.smoothing, streamline: 1 - brush.follow, rendering: 'segmented',
        simulatePressure: event.pointerType !== 'pen', points: [p], createdAt: new Date().toISOString()
      };
      current.stroke = stroke;
      current.ink = new RemoteInk(liveRef.current!, stroke);
      current.ink.render();
      send({ type: 'stroke-begin', canvasId: block.id, stroke: { ...stroke, points: [p] } });
    } else if (current.tool === 'eraser') erase(p);
    else current.polygon.push([p[0], p[1]]);
  }

  function move(event: ReactPointerEvent<SVGSVGElement>): void {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    if (current.transform) {
      const [x, y] = point(event, current);
      const initial = current.transform;
      const scale = initial.mode === 'resize'
        ? clamp(Math.hypot(x - initial.bounds.x, y - initial.bounds.y) / Math.max(1, Math.hypot(initial.x - initial.bounds.x, initial.y - initial.bounds.y)), 0.15, 6) : 1;
      update(transformDrawingSelection(current.before, selection, {
        originX: initial.bounds.x, originY: initial.bounds.y, scale,
        translateX: initial.mode === 'move' ? x - initial.x : 0,
        translateY: initial.mode === 'move' ? y - initial.y : 0
      }, payload.canvasWidth, payload.canvasHeight));
      return;
    }
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];
    for (const sample of samples) {
      const p = point(sample, current);
      if (current.stroke) {
        const previous = current.stroke.points.at(-1)!;
        if (Math.abs(previous[0] - p[0]) + Math.abs(previous[1] - p[1]) > 0.05 || Math.abs(previous[2] - p[2]) > 0.01) current.stroke.points.push(p);
      } else if (current.tool === 'eraser') erase(p);
      else current.polygon.push([p[0], p[1]]);
    }
    schedule();
  }

  function finish(event: ReactPointerEvent<SVGSVGElement>): void {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') { cancel(); return; }
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    // Pointerup often has pressure=0. Keep the final position without inventing
    // a zero-pressure tail (and do not discard the endpoint between move events).
    if (current.stroke) {
      const last = current.stroke.points.at(-1)!;
      const p = point({ ...event, clientX: event.clientX, clientY: event.clientY, pressure: event.pressure }, current);
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.1) current.stroke.points.push([p[0], p[1], last[2]]);
    }
    flush();
    gesture.current = undefined;
    event.currentTarget.closest('.remote-canvas')?.removeAttribute('data-writing');
    if (current.stroke) {
      remember(current.before);
      update([...latestPayload.current.strokes, current.stroke]);
      send({ type: 'stroke-commit', requestId: remoteId('commit'), canvasId: block.id, stroke: current.stroke });
    } else if (current.transform || current.tool === 'eraser') {
      if (strokesRef.current !== current.before) {
        remember(current.before);
        replace(strokesRef.current, false);
      }
    } else {
      setSelection(new Set(strokesRef.current.filter((stroke) => strokeIntersectsPolygon(stroke, current.polygon)).map((stroke) => stroke.id)));
    }
    lassoRef.current?.setAttribute('points', '');
  }

  function startTransform(mode: 'move' | 'resize', event: ReactPointerEvent<SVGSVGElement>): void {
    if (!bounds) return;
    const rect = event.currentTarget.getBoundingClientRect();
    start(event, { mode, bounds, x: (event.clientX - rect.left) * payload.canvasWidth / rect.width, y: (event.clientY - rect.top) * payload.canvasHeight / rect.height });
  }

  return <div className="remote-sheet__surface">
    <svg ref={svgRef} className={`remote-canvas__paper is-${browsing ? 'browse' : tool}${fingerWriting && !browsing ? ' allows-finger' : ''}`}
      viewBox={`0 0 ${payload.canvasWidth} ${payload.canvasHeight}`} aria-label={`PDF 第 ${block.pageNumber ?? 1} 页手写纸张`}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (target.closest('[data-selection-resize]')) startTransform('resize', event);
        else if (target.closest('[data-selection-move]')) startTransform('move', event);
        else start(event);
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onContextMenu={(event) => event.preventDefault()}>
      <g className="remote-ink-persisted">{strokes.map((stroke) => <DrawingStrokePath key={stroke.id} stroke={stroke} className={selection.has(stroke.id) ? 'is-selected' : undefined} />)}</g>
      <g className="remote-ink-peers">{Object.values(remoteStrokes ?? {}).filter((stroke) => !strokes.some((saved) => saved.id === stroke.id)).map((stroke) => <DrawingStrokePath key={stroke.id} stroke={stroke} active />)}</g>
      <g ref={liveRef} className="remote-ink-live" />
      <polyline ref={lassoRef} className="remote-canvas__lasso" />
      {bounds && active && tool === 'lasso' && !browsing && <g className="remote-canvas__selection-box">
        <rect data-selection-move x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} />
        <g data-selection-resize transform={`translate(${bounds.x + bounds.width - 9} ${bounds.y + bounds.height - 9})`}>
          <rect width="18" height="18" rx="5" /><Maximize2 width={14} height={14} x={2} y={2} />
        </g>
      </g>}
    </svg>
    {bounds && active && tool === 'lasso' && !browsing && <div className="remote-selection-actions">
      <span>{selection.size} 条笔迹</span>
      <button type="button" onClick={() => {
        const delivered = send({ type: 'share-selection', requestId: remoteId('share'), canvasId: block.id, strokes: strokes.filter((stroke) => selection.has(stroke.id)) });
        setNotice(delivered ? '已发送到电脑上的 AI 对话' : '连接恢复后可发送');
      }}><Send />发送到 AI</button>
      <button type="button" aria-label="删除选中笔迹" onClick={() => { replace(strokes.filter((stroke) => !selection.has(stroke.id))); setSelection(new Set()); }}><Trash2 /></button>
      <button type="button" aria-label="取消圈选" onClick={() => setSelection(new Set())}><X /></button>
    </div>}
    {notice && <div className="remote-canvas__notice" role="status">{notice}</div>}
  </div>;
}));
