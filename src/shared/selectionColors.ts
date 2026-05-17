import {
  defaultAppPreferences,
  type SelectionColorPreferences,
  type SelectionColorRole
} from './domain';

const hexColorPattern = /^#[0-9a-f]{6}$/i;

export function normalizeSelectionColors(input?: Partial<SelectionColorPreferences>): SelectionColorPreferences {
  const defaults = defaultAppPreferences.selectionColors;
  return {
    highlight: normalizeColor(input?.highlight, defaults.highlight),
    underline: normalizeColor(input?.underline, defaults.underline),
    chat: normalizeColor(input?.chat, defaults.chat),
    note: normalizeColor(input?.note, defaults.note),
    summary: normalizeColor(input?.summary, defaults.summary),
    translate: normalizeColor(input?.translate, defaults.translate)
  };
}

export function selectionColorForRole(
  role: SelectionColorRole | undefined,
  colors: SelectionColorPreferences
): string {
  return colors[role ?? 'highlight'] ?? colors.highlight;
}

function normalizeColor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : fallback;
}
