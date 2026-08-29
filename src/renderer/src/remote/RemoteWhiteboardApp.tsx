import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Expand,
  FileText,
  Minimize,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff
} from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanWhiteboardClientMessage, LanWhiteboardDocument, LanWhiteboardSide } from '../../../shared/lanWhiteboard';
import { RemoteCanvas } from './RemoteCanvas';
import { remoteDrawingPayload } from './remoteDrawing';
import { useLanWhiteboardSocket } from './useLanWhiteboardSocket';

export function RemoteWhiteboardApp(): ReactElement {
  const token = useMemo(() => new URLSearchParams(location.search).get('token') ?? '', []);
  const { clientCount, latency, lastAcknowledgement, send, snapshot, status, transientStrokes } = useLanWhiteboardSocket(token);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [pendingDelete, setPendingDelete] = useState<WorkspaceBlock>();

  const selectedCanvas = snapshot?.canvases.find((block) => block.id === selectedCanvasId);
  const contextDocument = snapshot?.documents.find((document) => document.id === snapshot.context?.documentId);
  const contextCanvases = snapshot?.canvases.filter((block) => block.documentId === snapshot.context?.documentId
    && block.pageNumber === snapshot.context?.pageNumber) ?? [];
  const notebookSide = contextCanvases[0] ? remoteDrawingPayload(contextCanvases[0]).side : 'left';
  const groupedCanvases = useMemo(() => groupCanvases(snapshot?.canvases ?? [], snapshot?.documents ?? []), [snapshot?.canvases, snapshot?.documents]);

  useEffect(() => {
    if (!snapshot || selectedCanvas) {
      return;
    }
    const contextCanvas = snapshot.canvases.find((block) => block.documentId === snapshot.context?.documentId
      && block.pageNumber === snapshot.context?.pageNumber);
    setSelectedCanvasId(contextCanvas?.id ?? snapshot.canvases[0]?.id);
  }, [selectedCanvas, snapshot]);

  useEffect(() => {
    if (lastAcknowledgement?.requestId.startsWith('canvas_') && lastAcknowledgement.canvasId) {
      setSelectedCanvasId(lastAcknowledgement.canvasId);
      setSidebarOpen(false);
    }
  }, [lastAcknowledgement]);

  useEffect(() => {
    const listener = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', listener);
    return () => document.removeEventListener('fullscreenchange', listener);
  }, []);

  const createCanvas = (side: LanWhiteboardSide): void => {
    const requestId = remoteId('canvas');
    send({
      type: 'create-canvas',
      requestId,
      documentId: snapshot?.context?.documentId,
      pageNumber: snapshot?.context?.pageNumber,
      side
    });
  };

  const deleteCanvas = (block: WorkspaceBlock): void => {
    send({ type: 'delete-canvas', requestId: remoteId('delete'), canvasId: block.id });
    setPendingDelete(undefined);
  };

  const moveCanvas = (block: WorkspaceBlock): void => {
    const side = remoteDrawingPayload(block).side === 'left' ? 'right' : 'left';
    send({ type: 'move-canvas', requestId: remoteId('move'), canvasId: block.id, side });
  };

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  };

  if (!token || status === 'invalid') {
    return (
      <main className="remote-gate">
        <div className="remote-gate__mark"><WifiOff /></div>
        <h1>连接链接已失效</h1>
        <p>请回到电脑上的 Tessel 设置，重新打开“局域网手写板”链接。</p>
      </main>
    );
  }

  return (
    <main className={`remote-app${sidebarOpen ? ' has-sidebar' : ''}${sidebarOpen && sidebarCompact ? ' is-sidebar-compact' : ''}`}>
      <header className="remote-header">
        <div className="remote-header__brand">
          <button
            type="button"
            className="remote-header__sidebar-toggle"
            aria-label={sidebarOpen ? '隐藏纸张列表' : '显示纸张列表'}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </button>
          <span className="remote-header__logo"><PenLine /></span>
          <span><strong>Tessel</strong><small>局域网手写</small></span>
        </div>
        <div className="remote-header__actions">
          <span className={`remote-status is-${status}`}>
            {status === 'connected' ? <Wifi /> : <RefreshCw className="is-spinning" />}
            <span>{status === 'connected' ? `${latency ?? '—'} ms` : '重连中'}</span>
            {clientCount > 1 && <small>{clientCount} 台设备</small>}
          </span>
          <button type="button" className="remote-header__button" aria-label={fullscreen ? '退出全屏' : '进入全屏'} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize /> : <Expand />}
          </button>
        </div>
      </header>

      <aside className={`remote-sidebar${sidebarOpen ? ' is-open' : ''}${sidebarCompact ? ' is-compact' : ''}`}>
        <div className="remote-sidebar__heading">
          <div><span>纸张</span><strong>{snapshot?.canvases.length ?? 0}</strong></div>
          <span className="remote-sidebar__heading-actions">
            <button
              type="button"
              title="在电脑当前页新增一张纸"
              aria-label="在电脑当前页新增一张纸"
              onClick={() => createCanvas(notebookSide)}
              disabled={!snapshot?.context}
            ><Plus /></button>
            <button
              type="button"
              title={sidebarCompact ? '展开纸张列表' : '缩小纸张列表'}
              aria-label={sidebarCompact ? '展开纸张列表' : '缩小纸张列表'}
              onClick={() => setSidebarCompact((value) => !value)}
            >{sidebarCompact ? <PanelLeftOpen /> : <PanelLeftClose />}</button>
          </span>
        </div>
        <div className="remote-sidebar__list">
          {groupedCanvases.map((group) => (
            <section className="remote-canvas-group" key={group.document.id}>
              <header><FileText /><span>{group.document.title}</span></header>
              {group.canvases.map((block) => {
                const payload = remoteDrawingPayload(block);
                return (
                  <div className={`remote-canvas-row${block.id === selectedCanvasId ? ' is-active' : ''}`} key={block.id}>
                    <button
                      type="button"
                      aria-label={`PDF 第 ${block.pageNumber ?? '—'} 页 · 纸张 ${sheetNumber(snapshot?.canvases ?? [], block)}`}
                      onClick={() => { setSelectedCanvasId(block.id); if (innerWidth < 760) setSidebarOpen(false); }}
                    >
                      <span className="remote-canvas-row__preview">
                        <Radio />
                      </span>
                      <span>
                        <strong>PDF 第 {block.pageNumber ?? '—'} 页 · 纸张 {sheetNumber(snapshot?.canvases ?? [], block)}</strong>
                        <small>{payload.strokes.length} 条笔迹</small>
                      </span>
                      <ChevronRight />
                    </button>
                    <button type="button" className="remote-canvas-row__delete" aria-label="删除纸张" onClick={() => setPendingDelete(block)}><Trash2 /></button>
                  </div>
                );
              })}
            </section>
          ))}
          {snapshot && snapshot.canvases.length === 0 && (
            <div className="remote-sidebar__empty">
              <span><PenIllustration /></span>
              <strong>还没有手写笔记</strong>
              <p>在电脑当前 PDF 页创建第一张纸。</p>
            </div>
          )}
          {!snapshot && <SidebarSkeleton />}
        </div>
        <div className="remote-sidebar__create">
          <small>{snapshot?.context ? `PDF 第 ${snapshot.context.pageNumber} 页 · ${contextCanvases.length} 张纸` : '等待电脑端页面'}</small>
          <button type="button" disabled={!snapshot?.context} onClick={() => createCanvas(notebookSide)}>
            <Plus />新增纸张
          </button>
        </div>
      </aside>

      {sidebarOpen && <button type="button" className="remote-sidebar-backdrop" aria-label="关闭纸张列表" onClick={() => setSidebarOpen(false)} />}

      <section className="remote-workspace">
        {selectedCanvas ? (
          <RemoteCanvas
            key={selectedCanvas.id}
            block={selectedCanvas}
            connected={status === 'connected'}
            canMove
            sheetNumber={sheetNumber(snapshot?.canvases ?? [], selectedCanvas)}
            totalSheets={(snapshot?.canvases ?? []).filter((block) => block.documentId === selectedCanvas.documentId && block.pageNumber === selectedCanvas.pageNumber).length}
            remoteStrokes={Object.values(transientStrokes[selectedCanvas.id] ?? {})}
            send={send}
            onDelete={() => setPendingDelete(selectedCanvas)}
            onMove={() => moveCanvas(selectedCanvas)}
          />
        ) : snapshot ? (
          <EmptyWorkspace contextDocument={contextDocument} pageNumber={snapshot.context?.pageNumber} onCreate={createCanvas} />
        ) : (
          <div className="remote-workspace__loading">
            <span className="remote-loading-ring" />
            <strong>正在连接 Tessel</strong>
            <p>保持电脑与平板处于同一局域网</p>
          </div>
        )}
      </section>

      {pendingDelete && (
        <div className="remote-dialog-backdrop" role="presentation" onPointerDown={() => setPendingDelete(undefined)}>
          <section className="remote-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-canvas-title" onPointerDown={(event) => event.stopPropagation()}>
            <span className="remote-dialog__icon"><Trash2 /></span>
            <h2 id="delete-canvas-title">删除这张纸？</h2>
            <p>PDF 第 {pendingDelete.pageNumber ?? '—'} 页的纸张 {sheetNumber(snapshot?.canvases ?? [], pendingDelete)}，其中全部笔迹会一起删除。</p>
            <div>
              <button type="button" onClick={() => setPendingDelete(undefined)}>取消</button>
              <button type="button" className="is-danger" onClick={() => deleteCanvas(pendingDelete)}>删除纸张</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function EmptyWorkspace({
  contextDocument,
  pageNumber,
  onCreate
}: {
  contextDocument?: LanWhiteboardDocument;
  pageNumber?: number;
  onCreate(side: LanWhiteboardSide): void;
}): ReactElement {
  return (
    <div className="remote-workspace__empty">
      <span><PenIllustration /></span>
      <small>{contextDocument?.title ?? 'Tessel'}</small>
      <h1>{pageNumber ? `为 PDF 第 ${pageNumber} 页创建笔记` : '在电脑上打开一份 PDF'}</h1>
      <p>笔记窗口默认位于 PDF 左侧，可以继续添加纸张并纵向滚动。</p>
      <div>
        <button type="button" disabled={!pageNumber} onClick={() => onCreate('left')}><Plus />创建笔记</button>
      </div>
    </div>
  );
}

function SidebarSkeleton(): ReactElement {
  return (
    <div className="remote-skeleton" aria-label="正在读取画布">
      <span /><span /><span />
    </div>
  );
}

function PenIllustration(): ReactElement {
  return (
    <svg viewBox="0 0 72 72" aria-hidden="true">
      <path d="M18 53c9-8 13-3 22-11 7-6 9-15 15-22" />
      <path d="m51 16 6 6" />
      <circle cx="18" cy="53" r="3" />
    </svg>
  );
}

function groupCanvases(canvases: WorkspaceBlock[], documents: LanWhiteboardDocument[]): Array<{ document: LanWhiteboardDocument; canvases: WorkspaceBlock[] }> {
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const groups = new Map<string, WorkspaceBlock[]>();
  for (const canvas of [...canvases].sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))) {
    groups.set(canvas.documentId, [...(groups.get(canvas.documentId) ?? []), canvas]);
  }
  return [...groups].map(([documentId, blocks]) => ({
    document: documentById.get(documentId) ?? { id: documentId, title: 'PDF', currentPage: 1 },
    canvases: blocks
  }));
}

function sheetNumber(canvases: WorkspaceBlock[], block: WorkspaceBlock): number {
  const sheets = canvases
    .filter((candidate) => candidate.documentId === block.documentId && candidate.pageNumber === block.pageNumber)
    .sort((a, b) => Number(a.payload?.sheetIndex ?? Number.MAX_SAFE_INTEGER) - Number(b.payload?.sheetIndex ?? Number.MAX_SAFE_INTEGER)
      || (remoteDrawingPayload(a).side === 'left' ? -1 : 1) - (remoteDrawingPayload(b).side === 'left' ? -1 : 1)
      || a.createdAt.localeCompare(b.createdAt));
  return Math.max(1, sheets.findIndex((candidate) => candidate.id === block.id) + 1);
}

function remoteId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}
