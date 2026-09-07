import { type RefObject, useLayoutEffect, useState } from 'react';

// Measure the reading column, not the PDF canvas: zooming the document must not
// resize or reposition its controls. Window/splitter resizing must do both.
export function useReaderViewport(ref: RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
