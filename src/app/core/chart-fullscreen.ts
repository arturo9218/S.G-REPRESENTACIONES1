export function getFullscreenElement(): Element | null {
  const d = document as Document & {
    webkitFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
  };
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? d.mozFullScreenElement ?? null;
}

export function isCurrentFullscreen(host: HTMLElement | null): boolean {
  if (!host) return false;
  return getFullscreenElement() === host;
}

export async function requestFullscreenBestEffort(el: HTMLElement): Promise<void> {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  if (typeof anyEl.requestFullscreen === 'function') {
    await anyEl.requestFullscreen();
  } else if (typeof anyEl.webkitRequestFullscreen === 'function') {
    anyEl.webkitRequestFullscreen();
  }
}

export async function exitFullscreenBestEffort(): Promise<void> {
  const d = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
  if (typeof document.exitFullscreen === 'function') {
    await document.exitFullscreen();
  } else if (typeof d.webkitExitFullscreen === 'function') {
    d.webkitExitFullscreen();
  }
}
