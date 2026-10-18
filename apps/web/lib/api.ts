'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly issues?: { path: string; message: string }[], readonly retryable?: boolean, readonly needsNewCode?: boolean) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: { 'x-tripos-csrf': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login') && !location.pathname.startsWith('/accept-invite')) location.href = '/login';
    throw new ApiError(e.message ?? `Request failed (${res.status})`, res.status, e.code, e.issues, e.retryable, e.needsNewCode);
  }
  return json as T;
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

/** Tiny data hook: loads on mount / when `deps` change, exposes reload + error. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError(e as ApiError); }
    finally { if (my === seq.current) setLoading(false); }
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, ...deps]);
  return { data, error, loading, reload: load, setData };
}
