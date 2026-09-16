import { useEffect, useMemo, useRef, useState } from 'react';

/** The generated document never shares the parent origin or credentials. */
export function previewDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('base, meta[http-equiv], iframe, frame, object, embed, portal').forEach(node => node.remove());
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  doc.head.prepend(csp);
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1';
  doc.head.append(viewport);
  const style = doc.createElement('style');
  style.textContent = 'html{min-height:100%;box-sizing:border-box}body{margin:0}svg{max-width:100%}';
  doc.head.append(style);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

export default function Preview({ html, title, compact = false }: { html: string; title: string; compact?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scripts, setScripts] = useState(false);
  const document = useMemo(() => previewDocument(html), [html]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return <div className={`preview-wrap ${compact ? 'preview-compact' : ''}`}>
    <div ref={container} className="preview-viewport" style={compact ? { height: width * (740 / 900) } : undefined}>
      <iframe key={`${scripts}`} title={`${title} · 隔离预览`} sandbox={scripts ? 'allow-scripts' : ''} referrerPolicy="no-referrer" srcDoc={document}
        loading="lazy" style={compact ? { width: 900, height: 740, transform: `scale(${width / 900})`, transformOrigin: 'top left', pointerEvents: 'none' } : undefined} />
    </div>
    {!compact && <label className="script-option"><input type="checkbox" checked={scripts} onChange={e => setScripts(e.target.checked)} />启用此作品的 JavaScript 动画<span>默认支持 CSS / SVG 动画；脚本在独立沙箱中运行。</span></label>}
  </div>;
}
