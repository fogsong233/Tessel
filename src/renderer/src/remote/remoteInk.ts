import type { LanDrawingStroke } from '../../../shared/lanWhiteboard';
import { drawingStrokePath, inkChunkSize, inkChunkOverlap } from '../drawing/drawingGeometry';

const namespace = 'http://www.w3.org/2000/svg';

/** Keep pointer-frame work bounded even when a stroke contains thousands of samples.
 * Completed chunks stay in the DOM; only the short tail is regenerated. React and
 * the persisted vector layer are updated once, when the pen lifts. */
export class RemoteInk {
  private offset = 0;
  private tail: SVGPathElement;

  constructor(private readonly layer: SVGGElement, private readonly stroke: LanDrawingStroke) {
    layer.replaceChildren();
    this.tail = this.appendPath();
  }

  render(): void {
    while (this.stroke.points.length - this.offset > inkChunkSize + inkChunkOverlap) {
      this.tail.setAttribute('d', this.path(this.offset, this.offset + inkChunkSize + inkChunkOverlap));
      this.offset += inkChunkSize;
      this.tail = this.appendPath();
    }
    this.tail.setAttribute('d', this.path(this.offset));
  }

  private path(start: number, end?: number): string {
    // A completed cap reaches the latest sample; an unfinished freehand path
    // deliberately trails the pointer and feels slow on a tablet.
    return drawingStrokePath({ ...this.stroke, points: this.stroke.points.slice(start, end) });
  }

  private appendPath(): SVGPathElement {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('fill', this.stroke.color);
    this.layer.append(path);
    return path;
  }
}

export function remoteId(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
