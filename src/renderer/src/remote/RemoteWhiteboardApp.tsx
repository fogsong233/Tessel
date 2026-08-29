import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Expand,
  FileText,
  Minimize,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  RefreshCw,
  Sparkles,
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
  const { clientCount, latency, send, snapshot, status, transientStrokes } = useLanWhiteboardSocket(token);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));

  const selectedCanvas = snapshot?.canvases.find((block) => block.id === selectedCanvasId);
  const contextDocument = snapshot?.documents.find((document) => document.id === snapshot.context?.documentId);
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
    if (!window.confirm(`删除“${block.title}”及其中全部笔迹？`)) {
      return;
    }
    send({ type: 'delete-canvas', requestId: remoteId('delete'), canvasId: block.id });
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
    <main className={`remote-app${sidebarOpen ? ' has-sidebar' : ''}`}>
      <header className="remote-header">
        <div className="remote-header__brand">
          <button
            type="button"
            className="remote-header__sidebar-toggle"
            aria-label={sidebarOpen ? '隐藏画布列表' : '显示画布列表'}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </button>
          <span className="remote-header__logo"><Sparkles /></span>
          <span><strong>Tessel</strong><small>局域网手写板</small></span>
        </div>
        <div className="remote-header__context">
          <FileText />
          <span>
            <strong>{contextDocument?.title ?? '等待电脑打开 PDF'}</strong>
            {snapshot?.context && <small>电脑当前页 · {snapshot.context.pageNumber}</small>}
          </span>
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

      <aside className={`remote-sidebar${sidebarOpen ? ' is-open' : ''}`}>
        <div className="remote-sidebar__heading">
          <div><span>画布</span><strong>{snapshot?.canvases.length ?? 0}</strong></div>
          <button type="button" title="在电脑当前页新建右侧画布" onClick={() => createCanvas('right')} disabled={!snapshot?.context}><Plus /></button>
        </div>
        <div className="remote-sidebar__list">
          {groupedCanvases.map((group) => (
            <section className="remote-canvas-group" key={group.document.id}>
              <header><FileText /><span>{group.document.title}</span></header>
              {group.canvases.map((block) => {
                const payload = remoteDrawingPayload(block);
                return (
                  <div className={`remote-canvas-row${block.id === selectedCanvasId ? ' is-active' : ''}`} key={block.id}>
                    <button type="button" onClick={() => { setSelectedCanvasId(block.id); if (innerWidth < 760) setSidebarOpen(false); }}>
                      <span className="remote-canvas-row__preview">
                        <Radio />
                      </span>
                      <span>
                        <strong>第 {block.pageNumber ?? '—'} 页 · {payload.side === 'left' ? '左侧' : '右侧'}</strong>
                        <small>{payload.strokes.length} 条笔迹</small>
                      </span>
                      <ChevronRight />
                    </button>
                    <button type="button" className="remote-canvas-row__delete" aria-label="删除画布" onClick={() => deleteCanvas(block)}><Trash2 /></button>
                  </div>
                );
              })}
            </section>
          ))}
          {snapshot && snapshot.canvases.length === 0 && (
            <div className="remote-sidebar__empty">
              <span><PenIllustration /></span>
              <strong>还没有画布</strong>
              <p>在电脑当前 PDF 页的左侧或右侧创建一张。</p>
            </div>
          )}
          {!snapshot && <SidebarSkeleton />}
        </div>
        <div className="remote-sidebar__create">
          <small>{snapshot?.context ? `电脑当前第 ${snapshot.context.pageNumber} 页` : '等待电脑端页面'}</small>
          <div>
            <button type="button" disabled={!snapshot?.context || status !== 'connected'} onClick={() => createCanvas('left')}><Plus />左侧画布</button>
            <button type="button" disabled={!snapshot?.context || status !== 'connected'} onClick={() => createCanvas('right')}><Plus />右侧画布</button>
          </div>
        </div>
      </aside>

      {sidebarOpen && <button type="button" className="remote-sidebar-backdrop" aria-label="关闭画布列表" onClick={() => setSidebarOpen(false)} />}

      <section className="remote-workspace">
        {selectedCanvas ? (
          <RemoteCanvas
            key={selectedCanvas.id}
            block={selectedCanvas}
            connected={status === 'connected'}
            remoteStrokes={Object.values(transientStrokes[selectedCanvas.id] ?? {})}
            send={send}
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
      <h1>{pageNumber ? `为第 ${pageNumber} 页创建画布` : '在电脑上打开一份 PDF'}</h1>
      <p>画布与 PDF 页面等宽，笔迹会实时出现在电脑端。</p>
      <div>
        <button type="button" disabled={!pageNumber} onClick={() => onCreate('left')}><Plus />放在左侧</button>
        <button type="button" disabled={!pageNumber} onClick={() => onCreate('right')}><Plus />放在右侧</button>
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

function remoteId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}
