import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { ArrowLeftRight, BookOpen, Check, ChevronDown, Eraser, Lasso, Minus, MoreHorizontal, PenLine, Plus, Redo2, Scan, Star, Trash2, Undo2, X } from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingStroke, LanWhiteboardClientMessage } from '../../../shared/lanWhiteboard';
import { drawingStrokePath } from '../drawing/drawingGeometry';
import { RemoteDrawingPage, type RemoteBrush, type RemotePageHandle, type RemoteTool } from './RemoteDrawingPage';
import { remoteDrawingPayload } from './remoteDrawing';
import { clamp } from './remoteInk';

interface Props {
  blocks: WorkspaceBlock[];
  selectedId: string;
  navigation?: { id: string; sequence: number };
  connected: boolean;
  remoteStrokes: Record<string, Record<string, LanDrawingStroke>>;
  send(message: LanWhiteboardClientMessage): boolean;
  onSelect(id: string): void;
  onDelete(block: WorkspaceBlock): void;
  onMove(block: WorkspaceBlock): void;
  onCreate(): void;
}
interface ZoomAnchor { id: string; x: number; y: number; clientX: number; clientY: number }
const brushKey = 'tessel.lan-whiteboard.brush';
const favoritesKey = 'tessel.lan-whiteboard.favorite-brushes';
const fingerKey = 'tessel.lan-whiteboard.finger-writing';
const colors = ['#171a16', '#2563eb', '#e0453b', '#16a36a', '#8b4bd6', '#e99620'];
const defaultBrush: RemoteBrush = { color: colors[0], size: 4, follow: 1, smoothing: 0.5 };

export function RemoteCanvas({ blocks, selectedId, navigation, connected, remoteStrokes, send, onSelect, onDelete, onMove, onCreate }: Props): ReactElement {
  const [brush, setBrush] = useState<RemoteBrush>(() => normalizeBrush(readStorage(brushKey)));
  const [favorites, setFavorites] = useState<RemoteBrush[]>(() => {
    const saved = readStorage(favoritesKey);
    return Array.isArray(saved) ? saved.slice(0, 6).map(normalizeBrush) : [];
  });
  const [tool, setTool] = useState<RemoteTool>('pen');
  const [browsing, setBrowsing] = useState(false);
  const [fingerWriting, setFingerWriting] = useState(() => readStorage(fingerKey) === true);
  const [brushOpen, setBrushOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<string, RemotePageHandle>());
  const pageRefs = useRef(new Map<string, (handle: RemotePageHandle | null) => void>());
  const zoomRef = useRef(zoom);
  const anchorRef = useRef<ZoomAnchor>();
  const scrollFrame = useRef<number>();
  const gestureRef = useRef<{ distance: number; zoom: number; anchor: ZoomAnchor }>();
  const navigating = useRef<string>();
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const selected = blocks.find((block) => block.id === selectedId) ?? blocks[0];
  const index = Math.max(0, blocks.findIndex((block) => block.id === selectedId));
  const widest = useMemo(() => Math.max(...blocks.map((block) => remoteDrawingPayload(block).canvasWidth)), [blocks]);
  const widestRef = useRef(widest);
  widestRef.current = widest;
  const favorite = favorites.some((item) => sameBrush(item, brush));
  const preview = useMemo(() => drawingStrokePath({
    id: 'preview', ...brush, streamline: 1 - brush.follow, simulatePressure: false, createdAt: '',
    points: Array.from({ length: 70 }, (_, i) => [18 + i * 3.6, 34 + Math.sin(i / 9) * 13, 0.1 + Math.sin(i / 69 * Math.PI) * 0.8])
  }), [brush]);

  useEffect(() => writeStorage(brushKey, brush), [brush]);
  useEffect(() => writeStorage(favoritesKey, favorites), [favorites]);
  useEffect(() => writeStorage(fingerKey, fingerWriting), [fingerWriting]);
  useEffect(() => {
    if (!brushOpen && !menuOpen) return;
    const dismiss = (event: PointerEvent): void => {
      if (!brushRef.current?.contains(event.target as Node)) setBrushOpen(false);
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setBrushOpen(false); setMenuOpen(false); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [brushOpen, menuOpen]);

  const sheetElement = useCallback((id: string): HTMLElement | undefined =>
    Array.from(viewportRef.current?.querySelectorAll<HTMLElement>('.remote-sheet') ?? []).find((node) => node.dataset.canvasId === id), []);
  const captureAnchor = useCallback((clientX?: number, clientY?: number): ZoomAnchor | undefined => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const x = clientX ?? rect.left + rect.width / 2;
    const y = clientY ?? rect.top + rect.height / 2;
    let closest: { sheet: HTMLElement; rect: DOMRect; distance: number } | undefined;
    for (const sheet of viewport.querySelectorAll<HTMLElement>('.remote-sheet')) {
      const box = sheet.getBoundingClientRect();
      const distance = Math.max(box.top - y, y - box.bottom, 0);
      if (!closest || distance < closest.distance) closest = { sheet, rect: box, distance };
    }
    if (!closest) return;
    return { id: closest.sheet.dataset.canvasId!, x: (x - closest.rect.left) / closest.rect.width,
      y: (y - closest.rect.top) / closest.rect.height, clientX: x, clientY: y };
  }, []);
  const changeZoom = useCallback((value: number, anchor?: ZoomAnchor): void => {
    if (rootRef.current?.dataset.writing === 'pen') return;
    const next = clamp(value, 0.2, 4);
    if (Math.abs(next - zoomRef.current) < 0.0001) return;
    anchorRef.current = anchor ?? captureAnchor();
    zoomRef.current = next;
    setZoom(next);
  }, [captureAnchor]);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const viewport = viewportRef.current;
    if (!anchor || !viewport) return;
    const box = sheetElement(anchor.id)?.getBoundingClientRect();
    if (box) {
      viewport.scrollLeft += box.left + box.width * anchor.x - anchor.clientX;
      viewport.scrollTop += box.top + box.height * anchor.y - anchor.clientY;
    }
    anchorRef.current = undefined;
  }, [zoom, sheetElement]);
  const fit = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    changeZoom(Math.min(1.5, (viewport.clientWidth - (viewport.clientWidth < 600 ? 32 : 96)) / widestRef.current), captureAnchor(rect.left + viewport.clientWidth / 2, rect.top));
  }, [changeZoom, captureAnchor]);
  useLayoutEffect(() => {
    if (!fitWidth || !viewportRef.current) return;
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [fitWidth, fit, widest]);
  const reportVisiblePage = useCallback((): void => {
    scrollFrame.current = undefined;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const box = viewport.getBoundingClientRect();
    const target = box.top + box.height * 0.4;
    let best: { id: string; distance: number } | undefined;
    for (const node of viewport.querySelectorAll<HTMLElement>('.remote-sheet')) {
      const rect = node.getBoundingClientRect();
      const distance = Math.max(rect.top - target, target - rect.bottom, 0);
      if (!best || distance < best.distance) best = { id: node.dataset.canvasId!, distance };
    }
    if (best && best.id !== selectedRef.current && !rootRef.current?.dataset.writing && !navigating.current) onSelect(best.id);
  }, [onSelect]);
  useEffect(() => {
    if (!navigation) return;
    const node = sheetElement(navigation.id);
    const viewport = viewportRef.current;
    if (!node || !viewport) return;
    navigating.current = navigation.id;
    const top = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 20;
    viewport.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    const done = (): void => { navigating.current = undefined; };
    viewport.addEventListener('scrollend', done, { once: true });
    const fallback = window.setTimeout(done, 1000);
    return () => { clearTimeout(fallback); viewport.removeEventListener('scrollend', done); navigating.current = undefined; };
  }, [navigation, sheetElement]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let pan: { id: number; x: number; y: number; left: number; top: number } | undefined;
    const wheel = (event: WheelEvent): void => {
      if (rootRef.current?.dataset.writing === 'pen') { event.preventDefault(); return; }
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setFitWidth(false);
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * 0.002), captureAnchor(event.clientX, event.clientY));
    };
    const touchStart = (event: TouchEvent): void => {
      if (rootRef.current?.dataset.writing === 'pen') { event.preventDefault(); return; }
      if (event.touches.length !== 2) return;
      pages.current.forEach((page) => page.cancel());
      event.preventDefault();
      const [a, b] = Array.from(event.touches);
      const anchor = captureAnchor((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      if (anchor) gestureRef.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: zoomRef.current, anchor };
      setFitWidth(false);
    };
    const touchMove = (event: TouchEvent): void => {
      if (rootRef.current?.dataset.writing === 'pen') { event.preventDefault(); return; }
      const pinch = gestureRef.current;
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const [a, b] = Array.from(event.touches);
      const anchor = { ...pinch.anchor, clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
      changeZoom(pinch.zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / Math.max(1, pinch.distance), anchor);
    };
    const touchEnd = (): void => { gestureRef.current = undefined; };
    const pointerDown = (event: PointerEvent): void => {
      if (gestureRef.current) return;
      if (event.pointerType !== 'mouse' || (!browsing && event.button !== 1 && !event.ctrlKey && !event.metaKey)) return;
      if ((event.target as Element).closest('button')) return;
      event.preventDefault(); event.stopPropagation();
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning');
    };
    const pointerMove = (event: PointerEvent): void => {
      if (!pan || pan.id !== event.pointerId) return;
      viewport.scrollLeft = pan.left + pan.x - event.clientX;
      viewport.scrollTop = pan.top + pan.y - event.clientY;
    };
    const pointerEnd = (): void => { pan = undefined; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('touchstart', touchStart, { passive: false });
    viewport.addEventListener('touchmove', touchMove, { passive: false });
    viewport.addEventListener('touchend', touchEnd);
    viewport.addEventListener('touchcancel', touchEnd);
    viewport.addEventListener('pointerdown', pointerDown, true);
    viewport.addEventListener('pointermove', pointerMove);
    viewport.addEventListener('pointerup', pointerEnd);
    viewport.addEventListener('pointercancel', pointerEnd);
    return () => {
      viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('touchstart', touchStart);
      viewport.removeEventListener('touchmove', touchMove); viewport.removeEventListener('touchend', touchEnd);
      viewport.removeEventListener('touchcancel', touchEnd); viewport.removeEventListener('pointerdown', pointerDown, true);
      viewport.removeEventListener('pointermove', pointerMove); viewport.removeEventListener('pointerup', pointerEnd);
      viewport.removeEventListener('pointercancel', pointerEnd);
    };
  }, [browsing, captureAnchor, changeZoom]);
  useEffect(() => () => { if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current); }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if ((event.target as Element)?.closest('input, textarea, select, [contenteditable]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) pages.current.get(selectedRef.current)?.redo();
        else pages.current.get(selectedRef.current)?.undo();
      }
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, []);
  function selectTool(next: RemoteTool): void { setTool(next); setBrowsing(false); }
  function patchBrush(patch: Partial<RemoteBrush>): void { setBrush((current) => ({ ...current, ...patch })); }
  function pageRef(id: string): (handle: RemotePageHandle | null) => void {
    if (!pageRefs.current.has(id)) pageRefs.current.set(id, (handle) => {
      if (handle) pages.current.set(id, handle);
      else pages.current.delete(id);
    });
    return pageRefs.current.get(id)!;
  }

  return <div ref={rootRef} className={`remote-canvas${browsing ? ' is-browsing' : ''}`}>
    <div className="remote-tools" role="toolbar" aria-label="手写工具">
      <div className="remote-mode" aria-label="操作模式">
        <button type="button" aria-label="手写模式" aria-pressed={!browsing} onClick={() => setBrowsing(false)}><PenLine /><span>手写</span></button>
        <button type="button" aria-label="浏览模式" aria-pressed={browsing} onClick={() => { pages.current.forEach((page) => page.cancel()); setBrowsing(true); setBrushOpen(false); }}><BookOpen /><span>浏览</span></button>
      </div>
      <span className="remote-tools__divider" />
      <div ref={brushRef} className="remote-brush-anchor">
        <button type="button" className={`remote-tool remote-pen${tool === 'pen' && !browsing ? ' is-active' : ''}`} aria-label="画笔设置" aria-expanded={brushOpen}
          onClick={() => { selectTool('pen'); setBrushOpen((value) => !value); }}>
          <span className="remote-pen__nib" style={{ color: brush.color }}><PenLine /></span><span>{brush.size} <small>px</small></span><ChevronDown />
        </button>
        {brushOpen && <section className="remote-brush-panel" role="region" aria-label="画笔设置">
          <header><div><strong>画笔</strong><small>颜色、粗细与书写偏好</small></div><button type="button" aria-label="关闭画笔设置" onClick={() => setBrushOpen(false)}><X /></button></header>
          <div className="remote-brush-preview"><svg viewBox="0 0 290 70" aria-label="笔触预览"><path d={preview} fill={brush.color} /></svg></div>
          <div className="remote-brush-colors">{colors.map((color) => <button type="button" key={color} aria-label={`墨水颜色 ${color}`} aria-pressed={brush.color === color} style={{ '--ink': color } as CSSProperties} onClick={() => patchBrush({ color })}>{brush.color === color && <Check />}</button>)}
            <label className="remote-custom-color" title="自定义墨水颜色"><Plus /><input type="color" aria-label="自定义墨水颜色" value={brush.color} onChange={(event) => patchBrush({ color: event.target.value })} /></label>
          </div>
          <div className="remote-brush-label"><span>粗细</span><output>{brush.size} px</output></div>
          <div className="remote-brush-width"><button type="button" aria-label="减小笔刷宽度" onClick={() => patchBrush({ size: clamp(brush.size - 1, 1, 40) })}><Minus /></button>
            <input type="range" min="1" max="40" step="0.5" aria-label="笔刷宽度" value={brush.size} onChange={(event) => patchBrush({ size: Number(event.target.value) })} />
            <button type="button" aria-label="增大笔刷宽度" onClick={() => patchBrush({ size: clamp(brush.size + 1, 1, 40) })}><Plus /></button>
          </div>
          <div className="remote-width-presets">{[2, 4, 8, 12].map((size) => <button type="button" key={size} aria-label={`${size} 像素笔刷`} aria-pressed={brush.size === size} onClick={() => patchBrush({ size })}><i style={{ width: size + 2, height: size + 2, background: brush.color }} /><span>{size}</span></button>)}</div>
          <div className="remote-favorites"><button type="button" aria-label={favorite ? '取消收藏当前笔刷' : '收藏当前笔刷'} aria-pressed={favorite}
            onClick={() => setFavorites((current) => favorite ? current.filter((item) => !sameBrush(item, brush)) : [...current, brush].slice(-6))}><Star />{favorite ? '已收藏' : '收藏笔刷'}</button>
            {favorites.map((item, i) => <button type="button" key={i} className="remote-favorite" aria-label={`使用收藏笔刷 ${item.color} ${item.size} 像素`} onClick={() => setBrush(item)}><i style={{ background: item.color, width: Math.min(20, item.size + 5), height: Math.min(20, item.size + 5) }} /></button>)}
          </div>
          <label className="remote-finger-setting"><span>手指书写<small>关闭时，单指滑动纸张</small></span><input type="checkbox" checked={fingerWriting} onChange={(event) => setFingerWriting(event.target.checked)} /></label>
          <details className="remote-brush-advanced"><summary>笔触调节<ChevronDown /></summary>
            <label><span>跟手程度 <output>{Math.round(brush.follow * 100)}%</output></span><input type="range" min="0" max="100" aria-label="笔触跟手程度" value={Math.round(brush.follow * 100)} onChange={(event) => patchBrush({ follow: Number(event.target.value) / 100 })} /></label>
            <label><span>笔触平滑 <output>{Math.round(brush.smoothing * 100)}%</output></span><input type="range" min="0" max="100" aria-label="笔触平滑程度" value={Math.round(brush.smoothing * 100)} onChange={(event) => patchBrush({ smoothing: Number(event.target.value) / 100 })} /></label>
          </details>
        </section>}
      </div>
      <ToolButton label="橡皮擦" active={!browsing && tool === 'eraser'} onClick={() => selectTool('eraser')}><Eraser /></ToolButton>
      <ToolButton label="圈选" active={!browsing && tool === 'lasso'} onClick={() => selectTool('lasso')}><Lasso /></ToolButton>
      <span className="remote-tools__divider" />
      <ToolButton label="撤销" onClick={() => pages.current.get(selectedId)?.undo()}><Undo2 /></ToolButton>
      <ToolButton label="重做" onClick={() => pages.current.get(selectedId)?.redo()}><Redo2 /></ToolButton>
      <span className="remote-tools__spacer" />
      <div ref={menuRef} className="remote-page-menu">
        <ToolButton label="纸张选项" active={menuOpen} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal /></ToolButton>
        {menuOpen && <div role="menu" aria-label="纸张选项">
          <button type="button" role="menuitem" onClick={() => { onCreate(); setMenuOpen(false); }}><Plus />新增纸张</button>
          <button type="button" role="menuitem" title={`把笔记窗口移到${remoteDrawingPayload(selected).side === 'left' ? '右' : '左'}侧`} onClick={() => { onMove(selected); setMenuOpen(false); }}><ArrowLeftRight />移到电脑{remoteDrawingPayload(selected).side === 'left' ? '右' : '左'}侧</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { onDelete(selected); setMenuOpen(false); }}><Trash2 />删除当前纸张</button>
        </div>}
      </div>
    </div>
    <div ref={viewportRef} className="remote-canvas__viewport" onScroll={() => { if (scrollFrame.current === undefined) scrollFrame.current = requestAnimationFrame(reportVisiblePage); }}>
      <div className="remote-canvas__pages" style={{ width: `max(100%, ${widest * zoom + 32}px)` }}>
        {blocks.map((block, position) => {
          const payload = remoteDrawingPayload(block);
          return <article className="remote-sheet" key={block.id} data-canvas-id={block.id} style={{ width: payload.canvasWidth * zoom }}>
            <header className="remote-sheet__label"><span>PDF 第 {block.pageNumber ?? 1} 页</span><span>{String(position + 1).padStart(2, '0')}</span></header>
            <div style={{ height: payload.canvasHeight * zoom }}>
              <RemoteDrawingPage ref={pageRef(block.id)}
                block={block} brush={brush} tool={tool} browsing={browsing} fingerWriting={fingerWriting} active={selectedId === block.id}
                remoteStrokes={remoteStrokes[block.id]} send={send} onActivate={onSelect} />
            </div>
          </article>;
        })}
        <button type="button" className="remote-add-page" onClick={onCreate}><Plus />新增纸张</button>
      </div>
    </div>
    <footer className="remote-canvas__footer">
      <div className="remote-canvas__identity"><span>纸张 {index + 1}/{blocks.length}</span><i /><span>连续滚动</span></div>
      <span className="remote-gesture-hint">{browsing ? '滑动浏览 · 双指缩放' : fingerWriting ? '手指或手写笔书写 · 双指缩放' : '手写笔书写 · 单指滑动 · 双指缩放'}</span>
      <div className="remote-zoom">
        <ToolButton label="缩小" onClick={() => { setFitWidth(false); changeZoom(zoomRef.current / 1.15); }}><Minus /></ToolButton>
        <button type="button" className="remote-zoom__value" title="恢复 100%" onClick={() => { setFitWidth(false); changeZoom(1); }}>{Math.round(zoom * 100)}%</button>
        <ToolButton label="放大" onClick={() => { setFitWidth(false); changeZoom(zoomRef.current * 1.15); }}><Plus /></ToolButton>
        <ToolButton label="适合宽度" active={fitWidth} onClick={() => { setFitWidth(true); fit(); }}><Scan /></ToolButton>
      </div>
    </footer>
    {!connected && <div className="remote-canvas__offline" role="status">连接中断，当前页面的笔迹将在重连后同步</div>}
  </div>;
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick(): void; children: ReactElement }): ReactElement {
  return <button type="button" className={`remote-tool${active ? ' is-active' : ''}`} title={label} aria-label={label} aria-pressed={active} onClick={onClick}>{children}</button>;
}
function sameBrush(a: RemoteBrush, b: RemoteBrush): boolean { return a.color === b.color && a.size === b.size && a.follow === b.follow && a.smoothing === b.smoothing; }
function normalizeBrush(value: unknown): RemoteBrush {
  const item = value && typeof value === 'object' ? value as Partial<RemoteBrush> : {};
  const number = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
  return { color: typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : defaultBrush.color,
    size: number(item.size, 4, 1, 40), follow: number(item.follow, 1, 0, 1), smoothing: number(item.smoothing, 0.5, 0, 1) };
}
function readStorage(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return undefined; } }
function writeStorage(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing can disable persistence. */ } }
