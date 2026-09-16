import { useEffect, useRef, useState } from 'react';
import type { Run } from '../shared/types';
import { api } from './api';

// This cache lives only in this tab's RAM. No browser storage or service worker.
const cache = new Map<string, Run>();
const activeArtifactPollMs = 15_000;
let cacheBytes = 0;
const payloadSize = (run: Run) => (run.output.length + run.html.length + run.reasoning.length) * 2;
export function forgetArtifacts(ids: string[]) {
  for (const id of ids) {
    const old = cache.get(id);
    if (old) { cacheBytes -= payloadSize(old); cache.delete(id); }
  }
}
function remember(run: Run) {
  const old = cache.get(run.id);
  if (old) cacheBytes -= payloadSize(old);
  cache.delete(run.id); cache.set(run.id, run); cacheBytes += payloadSize(run);
  while (cacheBytes > 16 * 1024 * 1024 || cache.size > 24) {
    const key = cache.keys().next().value;
    if (!key) break;
    cacheBytes -= payloadSize(cache.get(key)!); cache.delete(key);
  }
}

export function useArtifact(metadata: Run, active = true) {
  const [full, setFull] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setFull(null); setError(''); setLoading(false);
    const pending = metadata.status === 'queued' || metadata.status === 'running';
    if (!active || (!pending && (metadata.output || metadata.html || metadata.artifactAvailable === false))) return;
    let cancelled = false;
    let inFlight = false;
    let completed = false;
    let timer: number | undefined;
    let retries = 0;
    const cached = cache.get(metadata.id);
    if (cached) { setFull(cached); return; }
    const controller = new AbortController();
    const schedule = () => {
      clearTimeout(timer);
      if (!cancelled && !completed && !document.hidden) timer = window.setTimeout(() => void fetchRun(), activeArtifactPollMs);
    };
    const fetchRun = async () => {
      if (cancelled || completed || document.hidden || inFlight) return;
      inFlight = true;
      if (!pending) setLoading(true);
      try {
        const { run } = await api<{ run: Run }>(`/api/public/runs/${encodeURIComponent(metadata.id)}`, { signal: controller.signal });
        if (cancelled) return;
        setFull(run); setError(''); retries = 0;
        if (run.status === 'queued' || run.status === 'running') schedule();
        else { completed = true; remember(run); }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          if (pending && retries++ < 3) schedule();
        }
      } finally { inFlight = false; if (!cancelled) setLoading(false); }
    };
    const onVisibility = () => { if (document.hidden) clearTimeout(timer); else void fetchRun(); };
    document.addEventListener('visibilitychange', onVisibility);
    void fetchRun();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [metadata.id, metadata.artifactAvailable, metadata.status, metadata.output, metadata.html, active]);
  const hydrated = full?.id === metadata.id || !!metadata.output || !!metadata.html || metadata.artifactAvailable === false;
  return { run: full?.id === metadata.id ? { ...metadata, ...full } : metadata, loading, error, hydrated };
}

export function useVisible() {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '180px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}
