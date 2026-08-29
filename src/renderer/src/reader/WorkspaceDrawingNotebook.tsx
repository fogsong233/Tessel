import { type ReactElement } from 'react';
import { ArrowLeftRight, FileText, Plus } from 'lucide-react';
import type { WorkspaceBlock } from '../../../shared/domain';
import type { LanDrawingStroke } from '../../../shared/lanWhiteboard';
import { WorkspaceDrawingBlock, drawingBlockSide, type WorkspaceDrawingLabels } from './WorkspaceDrawingBlock';

export interface WorkspaceDrawingNotebookLabels extends WorkspaceDrawingLabels {
  addNotebookSheet: string;
  notebook: string;
  notebookSheet: string;
  notebookSheets: string;
}

interface WorkspaceDrawingNotebookProps {
  blocks: WorkspaceBlock[];
  height: number;
  remoteStrokes: Record<string, Record<string, LanDrawingStroke>>;
  text: WorkspaceDrawingNotebookLabels;
  width: number;
  onAddSheet(side: 'left' | 'right'): void;
  onDelete(blockId: string): void;
  onMoveSide(side: 'left' | 'right'): void;
  onSave(block: WorkspaceBlock): void;
  onShareSelection(pageNumber: number, canvasId: string, strokes: LanDrawingStroke[]): void;
}

export function WorkspaceDrawingNotebook({
  blocks,
  height,
  remoteStrokes,
  text,
  width,
  onAddSheet,
  onDelete,
  onMoveSide,
  onSave,
  onShareSelection
}: WorkspaceDrawingNotebookProps): ReactElement {
  const sheets = [...blocks].sort(compareSheets);
  const side = drawingBlockSide(sheets[0]);
  const nextSide = side === 'left' ? 'right' : 'left';

  return (
    <section className="workspace-notebook" style={{ width, height }}>
      <header className="workspace-notebook__header">
        <span className="workspace-notebook__mark"><FileText size={14} /></span>
        <span className="workspace-notebook__title">
          <strong>{text.notebook}</strong>
          <small>{sheets.length} {sheets.length === 1 ? text.notebookSheet : text.notebookSheets}</small>
        </span>
        <button type="button" title={text.addNotebookSheet} aria-label={text.addNotebookSheet} onClick={() => onAddSheet(side)}><Plus size={14} /></button>
        <button
          type="button"
          title={side === 'left' ? text.moveCanvasToRight : text.moveCanvasToLeft}
          aria-label={side === 'left' ? text.moveCanvasToRight : text.moveCanvasToLeft}
          onClick={() => onMoveSide(nextSide)}
        ><ArrowLeftRight size={14} /></button>
      </header>
      <div className="workspace-notebook__pages">
        {sheets.map((block, index) => {
          const canvasWidth = finitePositive(block.payload?.canvasWidth, block.width || 612);
          const canvasHeight = finitePositive(block.payload?.canvasHeight, block.height || 792);
          const sheetWidth = Math.max(240, width - 22);
          const sheetHeight = sheetWidth * canvasHeight / canvasWidth;
          return (
            <article className="workspace-notebook__sheet" data-sheet-id={block.id} key={block.id}>
              <div className="workspace-notebook__sheet-label">
                <span>{text.notebookSheet} {index + 1}</span>
                <small>{block.payload?.penOnly === true ? text.penOnlyMode : ''}</small>
              </div>
              <WorkspaceDrawingBlock
                block={block}
                canMoveSide
                height={sheetHeight}
                remoteStrokes={Object.values(remoteStrokes[block.id] ?? {})}
                showPlacementControl={false}
                text={text}
                width={sheetWidth}
                onDelete={() => onDelete(block.id)}
                onMoveSide={() => onMoveSide(nextSide)}
                onSave={onSave}
                onShareSelection={(strokes) => onShareSelection(block.pageNumber ?? 1, block.id, strokes)}
              />
            </article>
          );
        })}
        <button type="button" className="workspace-notebook__add-sheet" onClick={() => onAddSheet(side)}><Plus size={15} />{text.addNotebookSheet}</button>
      </div>
    </section>
  );
}

function compareSheets(a: WorkspaceBlock, b: WorkspaceBlock): number {
  const aIndex = Number(a.payload?.sheetIndex ?? Number.MAX_SAFE_INTEGER);
  const bIndex = Number(b.payload?.sheetIndex ?? Number.MAX_SAFE_INTEGER);
  return aIndex - bIndex
    || (drawingBlockSide(a) === 'left' ? -1 : 1) - (drawingBlockSide(b) === 'left' ? -1 : 1)
    || a.createdAt.localeCompare(b.createdAt);
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Math.max(1, fallback);
}
