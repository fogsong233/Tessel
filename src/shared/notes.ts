import type { NoteDocument } from './domain';

export function normalizeNoteRange(note: NoteDocument, pageCount?: number): NoteDocument {
  const fallbackEnd = Math.max(1, pageCount ?? 9999);
  const rawStart = Number.isFinite(note.pageStart) ? note.pageStart : 1;
  const rawEnd = Number.isFinite(note.pageEnd) ? note.pageEnd : fallbackEnd;
  const pageStart = Math.max(1, Math.floor(Math.min(rawStart, rawEnd)));
  const pageEnd = Math.max(pageStart, Math.floor(Math.max(rawStart, rawEnd)));

  return {
    ...note,
    pageStart,
    pageEnd,
    source: note.source ?? 'manual'
  };
}

export function mergeNoteDocuments(notes: NoteDocument[], pageCount?: number): NoteDocument[] {
  const merged = new Map<string, NoteDocument>();
  notes.forEach((note) => {
    if (!merged.has(note.id)) {
      merged.set(note.id, normalizeNoteRange(note, pageCount));
    }
  });

  return Array.from(merged.values())
    .sort((a, b) => a.pageStart - b.pageStart || a.pageEnd - b.pageEnd || b.updatedAt.localeCompare(a.updatedAt));
}

export function isPendingGeneratedNoteDraft(note: NoteDocument): boolean {
  return note.source === 'ai' && note.markdown.trim() === `# ${note.title}\n\nGenerating notes...`;
}
