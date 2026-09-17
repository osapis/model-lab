import { useMemo, type ReactNode } from 'react';
import './markdown.css';

const inlinePattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index!;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (link) nodes.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>);
      else nodes.push(token);
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderMarkdown(content: string): ReactNode[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^```(?:[a-zA-Z0-9_-]+)?\s*$/);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      index++;
      blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      const Tag = `h${level}` as 'h3';
      blocks.push(<Tag key={`heading-${blocks.length}`}>{renderInline(heading[2]!, `heading-${blocks.length}`)}</Tag>);
      index++;
      continue;
    }
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) { blocks.push(<hr key={`hr-${blocks.length}`} />); index++; continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.]\s+(.+)$/);
    if (bullet || ordered) {
      const items: string[] = [];
      const pattern = bullet ? /^\s*[-*]\s+(.+)$/ : /^\s*\d+[.]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index]!.match(pattern);
        if (!item) break;
        items.push(item[1]!); index++;
      }
      const children = items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `list-${blocks.length}-${itemIndex}`)}</li>);
      blocks.push(bullet ? <ul key={`list-${blocks.length}`}>{children}</ul> : <ol key={`list-${blocks.length}`}>{children}</ol>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^\s*>\s?/, '')); index++;
      }
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{renderInline(quote.join(' '), `quote-${blocks.length}`)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim()) paragraph.push(lines[index++]!);
    blocks.push(<p key={`paragraph-${blocks.length}`}>{renderInline(paragraph.join(' '), `paragraph-${blocks.length}`)}</p>);
  }
  return blocks;
}

export default function Markdown({ content, emptyText = '此记录没有文本输出。', className = '' }: { content: string; emptyText?: string; className?: string }) {
  const blocks = useMemo(() => renderMarkdown(content || emptyText), [content, emptyText]);
  return <div className={`markdown-output ${className}`.trim()} tabIndex={0}>{blocks}</div>;
}
