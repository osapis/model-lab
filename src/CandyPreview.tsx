import { useMemo, type CSSProperties } from 'react';
import { Check, X } from 'lucide-react';
import './candy-preview.css';

type CandyKind = 'wrapped' | 'round' | 'star' | 'lollipop';
interface Palette {
  name: string;
  background: string;
  light: string;
  ink: string;
  muted: string;
  accent: string;
  colors: readonly string[];
}
const palettes: readonly Palette[] = [
  { name: '薄荷蜜桃', background: '#eaf6ee', light: '#fff6e7', ink: '#365b49', muted: '#718673', accent: '#d89179', colors: ['#efb399', '#e8cc76', '#8fc6ad', '#b8aed8', '#9dcbd4'] },
  { name: '柠檬紫罗兰', background: '#fbf4d9', light: '#f5efff', ink: '#665332', muted: '#948269', accent: '#a793c6', colors: ['#ead273', '#bfaadd', '#f0bda2', '#a9cdb1', '#bdd9e2'] },
  { name: '莓果奶油', background: '#fbeaf0', light: '#fff7e4', ink: '#795064', muted: '#9a7a84', accent: '#d895b0', colors: ['#e5a4bd', '#f1d28e', '#a7cdc1', '#baabe0', '#eda889'] },
  { name: '海盐柠檬', background: '#e9f4fa', light: '#fff7db', ink: '#426275', muted: '#7c9298', accent: '#dfbd65', colors: ['#9fcbdc', '#ebce79', '#eab4aa', '#a6cbbb', '#b9b6dd'] },
  { name: '杏子花园', background: '#fff0e1', light: '#eff6e5', ink: '#78563f', muted: '#9b856f', accent: '#dba176', colors: ['#eda77c', '#b5cf9b', '#e6c871', '#c3b0d3', '#98c8c9'] },
  { name: '开心果樱花', background: '#eef4df', light: '#fff0f3', ink: '#586642', muted: '#849070', accent: '#dba0b3', colors: ['#b7cc83', '#e4b0c0', '#eec897', '#a7cdd1', '#c8b5d8'] },
  { name: '奶茶软糖', background: '#f5ecdf', light: '#f6edfa', ink: '#6a574a', muted: '#958476', accent: '#be9d7f', colors: ['#d6ab87', '#ecbaab', '#bdafd5', '#a9c8b0', '#e1c97b'] },
  { name: '葡萄青柠', background: '#f0eafb', light: '#f6f8df', ink: '#635475', muted: '#8e819e', accent: '#b4bc77', colors: ['#b5a1d4', '#c8d28c', '#e5aec7', '#a6cfd0', '#edc294'] },
];

function seedHash(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function randomFrom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Every shape is drawn locally. There are no image requests, filters or animation loops.
function CandyShape({ kind, color, detail }: { kind: CandyKind; color: string; detail: string }) {
  if (kind === 'wrapped') return <>
    <ellipse cx="0" cy="32" rx="54" ry="8" fill="#58442b" opacity=".07" />
    <path d="M-33-17-65-30-58-6-67 18-35 15Z M33-17 65-30 58-6 67 18 35 15Z" fill={color} opacity=".85" />
    <path d="M-59-20-39-8 M-59 9-40 4 M59-20 39-8 M59 9 40 4" fill="none" stroke="#fffdf6" strokeWidth="3" strokeLinecap="round" opacity=".7" />
    <rect x="-40" y="-29" width="80" height="57" rx="23" fill={color} />
    <path d="M-19-27-32 26 M7-29-7 28 M30-24 16 28" fill="none" stroke="#fffdf6" strokeWidth="13" opacity=".7" />
    <path d="M-26-18Q-7-27 13-19" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" opacity=".65" />
    <path d="M-33 19Q0 32 32 18" fill="none" stroke={detail} strokeWidth="3" opacity=".23" />
  </>;
  if (kind === 'lollipop') return <>
    <path d="M0 22V86" stroke="#a28d71" strokeWidth="10" strokeLinecap="round" opacity=".1" transform="translate(2 2)" />
    <path d="M0 22V83" stroke="#fffdf4" strokeWidth="9" strokeLinecap="round" />
    <path d="M-2 24V80" stroke="#e7dec8" strokeWidth="2" strokeLinecap="round" />
    <circle r="37" cy="-4" fill={color} />
    <circle r="31" cy="-4" fill="none" stroke="#fffdf7" strokeWidth="5" opacity=".65" />
    <path d="M2-5C-8-17-23-4-15 7S10 21 20 6 12-28-8-26" fill="none" stroke="#fffdf5" strokeWidth="7" strokeLinecap="round" opacity=".8" />
    <path d="M-24-19Q-17-29-6-29" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" opacity=".7" />
    <path d="M0 37-14 29-15 43 0 39 13 29 17 42Z" fill={detail} opacity=".8" />
  </>;
  if (kind === 'star') return <>
    <path d="M0-39 13-13 42-9 21 12 26 40 0 26-27 40-22 11-42-9-13-14Z" fill="#615438" opacity=".08" transform="translate(3 6)" />
    <path d="M0-39 13-13 42-9 21 12 26 40 0 26-27 40-22 11-42-9-13-14Z" fill={color} stroke={color} strokeWidth="5" strokeLinejoin="round" />
    <path d="M-1-24-9-5-28-3" fill="none" stroke="#fffef5" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity=".67" />
    <path d="M24 2 12 14 15 30" fill="none" stroke={detail} strokeWidth="4" strokeLinecap="round" opacity=".26" />
    <circle cx="-5" cy="11" r="3" fill="#fffef5" opacity=".5" />
  </>;
  return <>
    <ellipse cx="2" cy="33" rx="28" ry="7" fill="#594b36" opacity=".07" />
    <circle r="35" fill={color} />
    <circle r="25" fill="none" stroke="#fffdf5" strokeWidth="4" opacity=".65" />
    <path d="M-9-12C-22 1-5 18 9 8S10-21-7-24" fill="none" stroke="#fffdf5" strokeWidth="6" strokeLinecap="round" opacity=".85" />
    <path d="M-23-19Q-16-28-5-28" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" opacity=".72" />
    <path d="M27 2Q26 20 13 26" fill="none" stroke={detail} strokeWidth="4" strokeLinecap="round" opacity=".23" />
  </>;
}

export default function CandyPreview({
  answer,
  seed,
  state = 'success',
  unit,
  caption,
}: {
  answer: string;
  seed: string;
  state?: 'success' | 'error';
  unit?: string;
  caption?: string;
}) {
  const scene = useMemo(() => {
    const hash = seedHash(seed);
    const random = randomFrom(hash);
    const palette = palettes[hash % palettes.length];
    const anchors = [[104, 153], [292, 88], [495, 88], [738, 140], [100, 364], [803, 356], [147, 590], [344, 644], [556, 642], [759, 577]];
    const kinds: CandyKind[] = ['wrapped', 'round', 'star', 'lollipop'];
    const offset = Math.floor(random() * kinds.length);
    const candies = anchors.map(([x, y], index) => ({
      x: x + (random() - .5) * 35,
      y: y + (random() - .5) * 28,
      rotation: (random() - .5) * 65,
      scale: .78 + random() * .4,
      kind: kinds[(index + offset) % kinds.length],
      color: palette.colors[Math.floor(random() * palette.colors.length)],
      detail: palette.colors[(index + 2) % palette.colors.length],
    }));
    const confetti = Array.from({ length: 26 }, (_, index) => {
      const angle = random() * Math.PI * 2;
      const radius = .82 + random() * .18;
      return { x: 450 + Math.cos(angle) * 360 * radius, y: 365 + Math.sin(angle) * 270 * radius, rotation: random() * 180, color: palette.colors[index % palette.colors.length], size: 3 + random() * 4 };
    });
    return { palette, candies, confetti };
  }, [seed]);
  const characters = Array.from(answer).length;
  const variables = {
    '--candy-bg': scene.palette.background,
    '--candy-bg-light': scene.palette.light,
    '--candy-ink': scene.palette.ink,
    '--candy-muted': scene.palette.muted,
    '--candy-soft': '#fffdf4',
    '--candy-accent': scene.palette.accent,
    ...(state === 'error' ? {
      '--candy-bg': '#fce9e6',
      '--candy-bg-light': '#fff7f4',
      '--candy-ink': '#9c403b',
      '--candy-muted': '#b66e67',
      '--candy-accent': '#d77870',
    } : {}),
    '--candy-answer-scale': characters <= 3 ? 1 : characters <= 6 ? .82 : characters <= 10 ? .62 : .48,
  } as CSSProperties;

  return <div className="candy-preview" style={variables} data-palette={scene.palette.name} data-state={state}>
    <svg className="candy-preview-decor" viewBox="0 0 900 740" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <rect width="900" height="740" fill={state === 'error' ? '#fce9e6' : scene.palette.background} />
      <path d="M0 0H900V133C704 56 667 197 495 139S196 222 0 106Z" fill={scene.palette.light} opacity=".9" />
      <path d="M0 556C160 482 255 624 432 578S718 525 900 613V740H0Z" fill={scene.palette.light} opacity=".95" />
      <circle cx="13" cy="220" r="161" fill={scene.palette.colors[0]} opacity=".12" />
      <circle cx="903" cy="570" r="205" fill={scene.palette.colors[3]} opacity=".12" />
      <ellipse cx="450" cy="362" rx="292" ry="207" fill="#fffefa" opacity=".43" />
      <path d="M28 481Q64 438 116 470 M747 251Q796 222 848 261 M217 692Q254 677 284 699" fill="none" stroke={scene.palette.accent} strokeWidth="3" strokeLinecap="round" opacity=".2" />
      {scene.confetti.map((piece, index) => <g key={index} transform={`translate(${piece.x.toFixed(2)} ${piece.y.toFixed(2)}) rotate(${piece.rotation.toFixed(2)})`} fill={piece.color} opacity=".66">{index % 3 === 0 ? <path d="M0-7 2-2 7 0 2 2 0 7-2 2-7 0-2-2Z" /> : index % 3 === 1 ? <rect x="-2" y="-6" width="4" height="12" rx="2" /> : <circle r={piece.size} />}</g>)}
      {scene.candies.map((candy, index) => <g key={index} transform={`translate(${candy.x.toFixed(2)} ${candy.y.toFixed(2)}) rotate(${candy.rotation.toFixed(2)}) scale(${candy.scale.toFixed(3)})`}><CandyShape kind={candy.kind} color={candy.color} detail={candy.detail} /></g>)}
    </svg>
    <span className="candy-preview-state" aria-label={state === 'success' ? '答案正确' : '答案错误'}>{state === 'success' ? <Check size={15} strokeWidth={2.5} /> : <X size={15} strokeWidth={2.5} />}</span>
    <div className="candy-preview-content">
      <span className="candy-preview-label">模型的回答</span>
      <div className="candy-preview-answer" tabIndex={characters > 3 ? 0 : undefined} aria-label={`模型回答 ${answer}`}>{answer}</div>
      {unit && <span className="candy-preview-unit">{unit}</span>}
      {caption && <p className="candy-preview-caption">{caption}</p>}
    </div>
  </div>;
}
