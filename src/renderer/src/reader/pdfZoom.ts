export interface ZoomAnchor {
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  scrollLeft: number;
  scrollTop: number;
  pageNumber?: string;
  pageHeight?: number;
  pageWidth?: number;
  pageOffsetX?: number;
  pageOffsetY?: number;
}

export function readZoomAnchor(container: HTMLElement, clientX: number, clientY: number): ZoomAnchor {
  const containerRect = container.getBoundingClientRect();
  const offsetX = clamp(clientX - containerRect.left, 0, containerRect.width);
  const offsetY = clamp(clientY - containerRect.top, 0, containerRect.height);
  const page = pdfPageAtPoint(container, clientX, clientY);

  if (!page) {
    return {
      clientX,
      clientY,
      offsetX,
      offsetY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop
    };
  }

  const pageRect = page.getBoundingClientRect();
  return {
    clientX,
    clientY,
    offsetX,
    offsetY,
    scrollLeft: container.scrollLeft,
    scrollTop: container.scrollTop,
    pageNumber: page.dataset.pageNumber,
    pageHeight: pageRect.height,
    pageWidth: pageRect.width,
    pageOffsetX: clientX - pageRect.left,
    pageOffsetY: clientY - pageRect.top
  };
}

export function readViewportZoomAnchor(container: HTMLElement, currentPageNumber: number): ZoomAnchor {
  const containerRect = container.getBoundingClientRect();
  const centerX = containerRect.left + containerRect.width / 2;
  const centerY = containerRect.top + containerRect.height / 2;
  const centeredAnchor = readZoomAnchor(container, centerX, centerY);
  if (centeredAnchor.pageNumber) {
    return centeredAnchor;
  }

  const currentPage = container.querySelector<HTMLElement>(`.page[data-page-number="${currentPageNumber}"]`);
  if (currentPage) {
    const pageRect = currentPage.getBoundingClientRect();
    const clientX = clamp((Math.max(pageRect.left, containerRect.left) + Math.min(pageRect.right, containerRect.right)) / 2, containerRect.left, containerRect.right);
    const clientY = clamp((Math.max(pageRect.top, containerRect.top) + Math.min(pageRect.bottom, containerRect.bottom)) / 2, containerRect.top, containerRect.bottom);
    return {
      clientX,
      clientY,
      offsetX: clientX - containerRect.left,
      offsetY: clientY - containerRect.top,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      pageNumber: currentPage.dataset.pageNumber,
      pageHeight: pageRect.height,
      pageWidth: pageRect.width,
      pageOffsetX: clientX - pageRect.left,
      pageOffsetY: clientY - pageRect.top
    };
  }

  return centeredAnchor;
}

export function prepareZoomScrollSpace(container: HTMLElement, anchor: ZoomAnchor, scaleRatio: number): void {
  if (anchor.pageOffsetX === undefined || scaleRatio <= 1) {
    return;
  }

  const canvas = container.querySelector<HTMLElement>('.pdf-canvas');
  if (!canvas) {
    return;
  }

  const neededScrollLeft = anchor.scrollLeft + anchor.pageOffsetX * (scaleRatio - 1) + 24;
  const currentMaxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  if (neededScrollLeft <= currentMaxScrollLeft) {
    return;
  }

  const currentPaddingRight = Number.parseFloat(window.getComputedStyle(canvas).paddingRight) || 0;
  canvas.style.paddingRight = `${Math.ceil(currentPaddingRight + neededScrollLeft - currentMaxScrollLeft)}px`;
}

export function restoreZoomAnchor(
  container: HTMLElement,
  anchor: ZoomAnchor,
  scaleRatio: number,
  onRestored?: () => void
): void {
  const restore = (): void => {
    if (anchor.pageNumber && anchor.pageOffsetX !== undefined && anchor.pageOffsetY !== undefined) {
      const page = container.querySelector<HTMLElement>(`.page[data-page-number="${anchor.pageNumber}"]`);
      if (page) {
        const pageRect = page.getBoundingClientRect();
        const pageXRatio = anchor.pageWidth ? anchor.pageOffsetX / anchor.pageWidth : undefined;
        const pageYRatio = anchor.pageHeight ? anchor.pageOffsetY / anchor.pageHeight : undefined;
        const targetClientX = pageRect.left + (pageXRatio === undefined ? anchor.pageOffsetX * scaleRatio : pageRect.width * pageXRatio);
        const targetClientY = pageRect.top + (pageYRatio === undefined ? anchor.pageOffsetY * scaleRatio : pageRect.height * pageYRatio);
        container.scrollLeft += targetClientX - anchor.clientX;
        container.scrollTop += targetClientY - anchor.clientY;
        return;
      }
    }

    container.scrollLeft = anchor.scrollLeft * scaleRatio + anchor.offsetX * (scaleRatio - 1);
    container.scrollTop = anchor.scrollTop * scaleRatio + anchor.offsetY * (scaleRatio - 1);
  };

  const settle = (framesRemaining: number): void => {
    window.requestAnimationFrame(() => {
      restore();
      if (framesRemaining > 1) {
        settle(framesRemaining - 1);
      } else {
        onRestored?.();
      }
    });
  };
  settle(3);
}

function pdfPageAtPoint(container: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const directPage = target?.closest<HTMLElement>('.page[data-page-number]');
  if (directPage && container.contains(directPage)) {
    return directPage;
  }

  if (target?.closest('.reader-dock-lane, .workspace-block-card, .selection-toolbar, button, input, textarea, select, [contenteditable="true"]')) {
    return null;
  }

  const pages = Array.from(container.querySelectorAll<HTMLElement>('.page[data-page-number]'));
  return pages.find((page) => {
    const rect = page.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }) ?? null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
