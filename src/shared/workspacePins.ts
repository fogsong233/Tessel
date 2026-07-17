import { WorkspaceBlock, WorkspaceBlockContentKind, WorkspaceBlockKind } from './domain';

export interface WorkspaceBlockKindSpec {
  kind: WorkspaceBlockKind;
  label: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  defaultContentKind: WorkspaceBlockContentKind;
  openableSource: boolean;
}

export const workspaceBlockKindSpecs: Record<WorkspaceBlockKind, WorkspaceBlockKindSpec> = {
  conversation: {
    kind: 'conversation',
    label: 'Conversation',
    defaultWidth: 292,
    minWidth: 220,
    maxWidth: 560,
    minHeight: 120,
    maxHeight: 720,
    defaultContentKind: 'markdown',
    openableSource: true
  },
  translation: {
    kind: 'translation',
    label: 'Translation',
    defaultWidth: 292,
    minWidth: 220,
    maxWidth: 620,
    minHeight: 120,
    maxHeight: 760,
    defaultContentKind: 'markdown',
    openableSource: true
  },
  note: {
    kind: 'note',
    label: 'Note',
    defaultWidth: 292,
    minWidth: 220,
    maxWidth: 620,
    minHeight: 120,
    maxHeight: 760,
    defaultContentKind: 'markdown',
    openableSource: true
  },
  snapshot: {
    kind: 'snapshot',
    label: 'Snapshot',
    defaultWidth: 320,
    minWidth: 220,
    maxWidth: 680,
    minHeight: 140,
    maxHeight: 760,
    defaultContentKind: 'image',
    openableSource: false
  },
  card: {
    kind: 'card',
    label: 'Card',
    defaultWidth: 292,
    minWidth: 200,
    maxWidth: 560,
    minHeight: 120,
    maxHeight: 680,
    defaultContentKind: 'markdown',
    openableSource: false
  },
  quote: {
    kind: 'quote',
    label: 'Quote',
    defaultWidth: 292,
    minWidth: 200,
    maxWidth: 560,
    minHeight: 96,
    maxHeight: 520,
    defaultContentKind: 'text',
    openableSource: false
  },
  image: {
    kind: 'image',
    label: 'Image',
    defaultWidth: 320,
    minWidth: 220,
    maxWidth: 760,
    minHeight: 160,
    maxHeight: 820,
    defaultContentKind: 'image',
    openableSource: false
  },
  link: {
    kind: 'link',
    label: 'Link',
    defaultWidth: 300,
    minWidth: 220,
    maxWidth: 560,
    minHeight: 96,
    maxHeight: 520,
    defaultContentKind: 'external',
    openableSource: false
  },
  embed: {
    kind: 'embed',
    label: 'Embed',
    defaultWidth: 360,
    minWidth: 260,
    maxWidth: 820,
    minHeight: 180,
    maxHeight: 900,
    defaultContentKind: 'custom',
    openableSource: false
  }
};

export function workspaceBlockSpec(kind: WorkspaceBlockKind): WorkspaceBlockKindSpec {
  return workspaceBlockKindSpecs[kind] ?? workspaceBlockKindSpecs.card;
}

export function defaultWorkspaceBlockWidth(kind: WorkspaceBlockKind): number {
  return workspaceBlockSpec(kind).defaultWidth;
}

export function normalizeWorkspaceBlock(block: WorkspaceBlock): WorkspaceBlock {
  const spec = workspaceBlockSpec(block.kind);
  return {
    ...block,
    contentKind: block.contentKind ?? spec.defaultContentKind,
    x: Math.max(-2400, Math.min(3600, Math.floor(block.x))),
    y: Math.max(0, Math.floor(block.y)),
    width: Math.max(spec.minWidth, Math.min(spec.maxWidth, Math.floor(block.width))),
    height: block.height === undefined
      ? undefined
      : Math.max(spec.minHeight, Math.min(spec.maxHeight, Math.floor(block.height)))
  };
}

export function canOpenWorkspaceBlockSource(block: WorkspaceBlock): boolean {
  return workspaceBlockSpec(block.kind).openableSource && Boolean(block.sourceId);
}
