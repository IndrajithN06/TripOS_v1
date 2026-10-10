'use client';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { STATUS_LABEL } from '@/lib/format';

export interface Me {
  user: { id: string; name: string; email: string; role: 'SUPER_ADMIN' | 'AGENCY_ADMIN' | 'SALES'; mfaEnabled: boolean; canOverrideRates: boolean };
  agency: { id: string; name: string; status: string; timezone: string; brandColour: string; logoUrl: string | null; salesVisibility: string } | null;
  permissions: string[];
  environment: { nodeEnv: string; whatsapp: string; whatsappSimulated: boolean; ai: string; aiAvailable: boolean; storage: string };
}
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
export const can = (me: Me, perm: string) => me.permissions.includes(perm);

type Toast = { id: number; msg: string; err?: boolean };
const ToastContext = createContext<(msg: string, err?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((msg: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, msg, err }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), err ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>{t.msg}</div>)}</div>
    </ToastContext.Provider>
  );
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message + (e.issues?.length ? `: ${e.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : '') : (e as Error)?.message ?? 'Something went wrong');

/** Runs an async action with toast feedback. Returns undefined on failure. */
export function useAction() {
  const toast = useToast();
  return useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(errMsg(e), true); return undefined; }
  }, [toast]);
}

export function Modal({ title, onClose, children, narrow }: { title: string; onClose: () => void; children: React.ReactNode; narrow?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${narrow ? 'narrow' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="btn sm" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  accepted: 'green', sent: 'blue', delivered: 'green', read: 'green', active: 'green', approved: 'green', negotiating: 'amber', ready_to_send: 'amber', partially_sent: 'amber', submitted: 'amber', pending: 'amber', sending: 'amber', invited: 'amber',
  setup_pending: 'amber', declined: 'red', failed: 'red', send_failed: 'red', rejected: 'red', suspended: 'red', disabled: 'red', expired: 'gray', draft: 'gray', local_draft: 'gray', queued: 'gray', paused: 'gray',
};
export function StatusBadge({ s }: { s: string }) { return <span className={`badge ${TONE[s] ?? ''}`}>{STATUS_LABEL[s] ?? s.replace(/_/g, ' ')}</span>; }
export function SimTag() { return <span className="sim-tag" title="Simulated: nothing was sent through a real WhatsApp provider">SIMULATED</span>; }
export function Loading({ what = 'Loading' }: { what?: string }) { return <div className="empty" role="status">{what}…</div>; }
export function ErrorBox({ e, retry }: { e: ApiError | Error | null; retry?: () => void }) {
  if (!e) return null;
  return <div className="banner err row between" role="alert"><span>{errMsg(e)}</span>{retry && <button className="btn sm" onClick={retry}>Retry</button>}</div>;
}
export function Empty({ children }: { children: React.ReactNode }) { return <div className="empty">{children}</div>; }
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label>{label}{children}</label>; }
