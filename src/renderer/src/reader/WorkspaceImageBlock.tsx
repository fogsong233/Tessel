import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { Copy, Move, Trash2 } from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';

export interface WorkspaceImagePayload {
  dataUrl?: string;
  name?: string;
  panX: number;
  panY: number;
  zoom: number;
}

export interface WorkspaceImageLabels {
  copyImage: string;
  deleteImage: string;
  resetImageZoom: string;
}

interface WorkspaceImageBlockProps {
  block: WorkspaceBlock;
  payload: WorkspaceImagePayload;
  text: WorkspaceImageLabels;
  onCopy(): void;
  onDelete(): void;
  onMove(event: ReactMouseEvent<HTMLElement>): void;
  onSave(block: WorkspaceBlock): void;
}

export function imageBlockPayload(block: WorkspaceBlock): WorkspaceImagePayload | undefined {
  if (block.kind !== 'image' || !block.payload) {
    return undefined;
  }

  const dataUrl = typeof block.payload.dataUrl === 'string' ? block.payload.dataUrl : undefined;
  const name = typeof block.payload.name === 'string' ? block.payload.name : undefined;
  const zoom = typeof block.payload.zoom === 'number' ? clamp(block.payload.zoom, 25, 800) : 100;
  const panX = typeof block.payload.panX === 'number' ? Math.max(0, block.payload.panX) : 0;
  const panY = typeof block.payload.panY === 'number' ? Math.max(0, block.payload.panY) : 0;
  return { dataUrl, name, panX, panY, zoom };
}

export function WorkspaceImageBlock({
  block,
  payload,
  text,
  onCopy,
  onDelete,
  onMove,
  onSave
}: WorkspaceImageBlockProps): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rightButtonHeldRef = useRef(false);
  const persistTimerRef = useRef<number>();
  const [zoom, setZoom] = useState(payload.zoom);

  const persistView = useCallback((nextZoom: number, panX: number, panY: number): void => {
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      onSave({
        ...block,
        payload: {
          ...block.payload,
          zoom: Math.round(nextZoom),
          panX: Math.round(Math.max(0, panX)),
          panY: Math.round(Math.max(0, panY))
        },
        updatedAt: new Date().toISOString()
      });
    }, 180);
  }, [block, onSave]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollLeft = payload.panX;
    viewport.scrollTop = payload.panY;
  }, [block.id]);

  useEffect(() => () => {
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const releaseRightButton = (): void => {
      rightButtonHeldRef.current = false;
    };
    window.addEventListener('pointerup', releaseRightButton);
    window.addEventListener('blur', releaseRightButton);
    return () => {
      window.removeEventListener('pointerup', releaseRightButton);
      window.removeEventListener('blur', releaseRightButton);
    };
  }, []);

  const resetZoom = (): void => {
    const viewport = viewportRef.current;
    setZoom(100);
    if (viewport) {
      viewport.scrollTo({ left: 0, top: 0 });
      persistView(100, 0, 0);
    }
  };

  const zoomAroundPointer = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (!rightButtonHeldRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const contentX = viewport.scrollLeft + pointerX;
    const contentY = viewport.scrollTop + pointerY;
    const step = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = clamp(zoom * step, 25, 800);
    const ratio = nextZoom / zoom;
    setZoom(nextZoom);

    window.requestAnimationFrame(() => {
      viewport.scrollLeft = contentX * ratio - pointerX;
      viewport.scrollTop = contentY * ratio - pointerY;
      persistView(nextZoom, viewport.scrollLeft, viewport.scrollTop);
    });
  };

  return (
    <div className="workspace-image">
      <div
        ref={viewportRef}
        className="workspace-image__viewport"
        onContextMenu={(event) => event.preventDefault()}
        onMouseDown={(event) => {
          if (event.button === 0) {
            onMove(event);
          }
        }}
        onPointerDown={(event) => {
          if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            rightButtonHeldRef.current = true;
          }
        }}
        onPointerCancel={() => {
          rightButtonHeldRef.current = false;
        }}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          persistView(zoom, viewport.scrollLeft, viewport.scrollTop);
        }}
        onWheel={zoomAroundPointer}
      >
        <img
          src={payload.dataUrl}
          alt={payload.name ?? block.title}
          draggable={false}
          style={{ width: `${zoom}%` }}
        />
      </div>
      <span className="workspace-image__zoom" aria-live="polite">{Math.round(zoom)}%</span>
      <div className="workspace-block-card__image-actions">
        <button type="button" title={text.resetImageZoom} aria-label={text.resetImageZoom} onClick={resetZoom}>
          <Move size={13} />
        </button>
        <button type="button" title={text.copyImage} aria-label={text.copyImage} onClick={onCopy}>
          <Copy size={13} />
        </button>
        <button type="button" title={text.deleteImage} aria-label={text.deleteImage} onClick={onDelete}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
