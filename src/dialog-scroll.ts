// Native dialogs share one document scroll lock, including sheet-to-result transitions.
let depth = 0;
let restore: (() => void) | undefined;
let savedPosition: { x: number; y: number } | undefined;

export function scrollPageToTop(): void {
  if (savedPosition) { savedPosition.x = 0; savedPosition.y = 0; }
  window.scrollTo(0, 0);
}

export function lockPageScroll(): () => void {
  if (depth++ === 0) {
    const body = document.body;
    const root = document.documentElement;
    const position = { x: window.scrollX, y: window.scrollY };
    savedPosition = position;
    const properties = ['position', 'top', 'left', 'right', 'width', 'padding-right'] as const;
    const original = properties.map(name => [name, body.style.getPropertyValue(name)] as const);
    const overflow = root.style.overflow;
    const scrollbar = window.innerWidth - root.clientWidth;
    const padding = parseFloat(getComputedStyle(body).paddingRight) || 0;
    root.style.overflow = 'hidden';
    Object.assign(body.style, { position: 'fixed', top: `${-position.y}px`, left: `${-position.x}px`, right: '0', width: '100%' });
    if (scrollbar > 0) body.style.paddingRight = `${padding + scrollbar}px`;
    restore = () => {
      for (const [name, value] of original) { if (value) body.style.setProperty(name, value); else body.style.removeProperty(name); }
      root.style.overflow = overflow;
      window.scrollTo(position.x, position.y);
      savedPosition = undefined;
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--depth === 0) { restore?.(); restore = undefined; }
  };
}
