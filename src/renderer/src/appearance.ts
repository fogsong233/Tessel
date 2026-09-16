import type { AppearanceFont } from '../../shared/domain';

// Explicit CJK fallbacks avoid bitmap-like legacy fallback fonts for the small
// Chinese labels on Windows. Keep the system stack aligned with design-tokens.
export function fontStack(font: AppearanceFont): string {
  switch (font) {
    case 'serif':
      return 'Iowan Old Style, Charter, Georgia, "Noto Serif CJK SC", "Source Han Serif SC", ui-serif, serif';
    case 'rounded':
      return 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif';
    case 'mono':
      return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Microsoft YaHei UI", monospace';
    default:
      return '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", sans-serif';
  }
}
