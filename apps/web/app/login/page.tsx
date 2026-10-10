'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errMsg } from '@/components/ui';

export default function Login() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [mfaCode, setMfa] = useState('');
  const [needMfa, setNeedMfa] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('/auth/login', { body: { email, password, mfaCode: mfaCode || undefined } });
      if (r.mfaRequired) { setNeedMfa(true); return; }
      location.href = r.role === 'SUPER_ADMIN' ? '/platform' : '/dashboard';
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <main className="auth"><form className="card stack" onSubmit={submit}>
      <h1>Sign in to TripOS</h1>
      {err && <div className="banner err" role="alert">{err}</div>}
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {needMfa && <label>Authenticator code<input inputMode="numeric" maxLength={6} autoFocus required value={mfaCode} onChange={(e) => setMfa(e.target.value)} /></label>}
      <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form></main>
  );
}
