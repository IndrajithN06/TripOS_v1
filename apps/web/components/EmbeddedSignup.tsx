'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, useApi } from '@/lib/api';
import { createSignupTracker, explainSignupError, parseSignupMessage } from '@/lib/embedded-signup';
import { Field } from '@/components/ui';

declare global {
  interface Window { FB?: any; fbAsyncInit?: () => void }
}

const SDK_ID = 'facebook-jssdk';
let sdkPromise: Promise<void> | null = null;

/** Loads Meta's JavaScript SDK once and initialises it with the (public) app id. Nothing secret is ever sent to the browser. */
function loadFacebookSdk(appId: string, version: string): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version }); resolve(); };
    if (document.getElementById(SDK_ID)) return;
    const s = document.createElement('script');
    s.id = SDK_ID; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.onerror = () => { sdkPromise = null; reject(new Error('Could not load the Meta sign-up library. Check your network or ad blocker.')); };
    document.body.appendChild(s);
  });
  return sdkPromise;
}

type Phase = 'idle' | 'starting' | 'popup' | 'finishing' | 'done';

/**
 * WhatsApp Embedded Signup v4 for a number that is already used in the WhatsApp Business app (coexistence).
 * Renders nothing unless the server has the feature enabled. The existing manual connection stays available below it.
 */
export function EmbeddedSignup({ existingLive, onDone }: { existingLive: boolean; onDone: () => void }) {
  const { data: cfg, error, reload } = useApi<any>('/agency/whatsapp/embedded');
  const [displayName, setDisplayName] = useState('');
  const [requestSync, setRequestSync] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<{ text: string; err?: boolean } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  if (error || !cfg?.enabled) return null; // disabled (or not reachable): the manual form below is all there is
  const blocked = existingLive || cfg.blockedByExistingConnection;
  const attempt = cfg.attempt;
  const resumable = attempt && attempt.status === 'failed' && !attempt.needsNewCode;
  const busy = phase === 'starting' || phase === 'popup' || phase === 'finishing';
  const fail = (e: unknown) => {
    setPhase('idle');
    const ae = e instanceof ApiError ? e : null;
    setMessage({ text: explainSignupError(ae?.code, ae?.message ?? (e as Error).message ?? 'Something went wrong'), err: true });
    reload();
  };

  async function complete(a: { attemptId: string; state: string }, code: string | undefined, finish: { type: string; wabaId?: string; phoneNumberId?: string; businessId?: string }) {
    setPhase('finishing'); setMessage({ text: 'Finishing the connection with Meta. This can take a few seconds…' });
    try {
      await api('/agency/whatsapp/embedded/complete', { body: { attemptId: a.attemptId, state: a.state, ...(code ? { code } : {}), event: finish, displayName: displayName.trim() } });
      setPhase('done'); setMessage({ text: 'Connected. Contacts and chats will appear as Meta sends them.' });
      reload(); onDone();
    } catch (e) { fail(e); }
  }

  async function begin(resume: boolean) {
    if (displayName.trim().length < 2) { setMessage({ text: 'Enter a display name for this line first.', err: true }); return; }
    setMessage(null); setPhase('starting');
    let started: any;
    try { started = await api('/agency/whatsapp/embedded/start', { body: { requestSync } }); } catch (e) { fail(e); return; }
    if (resume) { await complete(started, undefined, { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' }); return; }
    if (!started.appId || !started.configId) { fail(new Error('Embedded Signup is not fully configured on the server.')); return; }
    try { await loadFacebookSdk(started.appId, started.graphVersion); } catch (e) { fail(e); return; }

    setPhase('popup');
    const tracker = createSignupTracker(
      ({ code, finish }) => { stop(); void complete(started, code, finish); },
      (reason) => { stop(); void api('/agency/whatsapp/embedded/cancel', { body: { attemptId: started.attemptId } }).catch(() => undefined); setPhase('idle'); setMessage({ text: reason, err: true }); reload(); },
    );
    const onMsg = (ev: MessageEvent) => { const m = parseSignupMessage(ev.origin, ev.data); if (m) tracker.setMessage(m); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { window.removeEventListener('message', onMsg); if (timer) clearTimeout(timer); cleanup.current = null; };
    window.addEventListener('message', onMsg);
    cleanup.current = stop;
    window.FB.login((resp: any) => {
      const code = resp?.authResponse?.code;
      if (typeof code === 'string' && code) {
        tracker.setCode(code);
        // The one-time code lives about 30 seconds: if Meta never reports the finished accounts, stop instead of hanging.
        timer = setTimeout(() => { if (!tracker.settled) { stop(); setPhase('idle'); setMessage({ text: 'Meta did not report the connected account in time. Nothing was connected. Try again.', err: true }); } }, 20000);
      } else tracker.loginClosedWithoutCode();
    }, { config_id: started.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
  }

  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line, #ddd)', paddingTop: 12 }}>
      <h3 style={{ margin: 0 }}>Connect your WhatsApp Business app number</h3>
      <div className="small muted">
        Keep using the WhatsApp Business app on your phone while TripOS also sends quotes and shows your chats. Meta turns off a few app features on a connected
        number (disappearing messages, view-once, live location, broadcast lists, group sync), and the app must be opened at least every 14 days to stay linked.
      </div>
      {blocked && <div className="banner warn small">This agency already has a WhatsApp connection. It will not be changed. Disconnect it first if you want to replace it.</div>}
      {attempt && attempt.status === 'failed' && !message && <div className="banner err small" role="alert">The last attempt stopped at “{attempt.failedStep}”: {explainSignupError(attempt.lastErrorCode, attempt.lastError ?? 'it failed')}</div>}
      <Field label="Display name for this line"><input value={displayName} disabled={busy || blocked} onChange={(e) => setDisplayName(e.target.value)} /></Field>
      <label className="small row"><input type="checkbox" checked={requestSync} disabled={busy || blocked} onChange={(e) => setRequestSync(e.target.checked)} /> Also import my contacts and up to 6 months of chat history (you can decline history inside Meta's window)</label>
      {message && <div className={`banner ${message.err ? 'err' : 'warn'} small`} role={message.err ? 'alert' : 'status'}>{message.text}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || blocked || phase === 'done'} onClick={() => void begin(false)}>{phase === 'popup' ? 'Waiting for Meta…' : 'Connect with Facebook'}</button>
        {resumable && <button className="btn" disabled={busy || blocked} onClick={() => void begin(true)}>Resume where it stopped</button>}
      </div>
    </div>
  );
}
