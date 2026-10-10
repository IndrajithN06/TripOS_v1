'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { errMsg } from '@/components/ui';

function Form() {
  const token = useSearchParams().get('token') ?? '';
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState(''), [err, setErr] = useState(''), [done, setDone] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('Passwords do not match');
    try { await api('/auth/accept-invite', { body: { token, password: pw } }); setDone(true); } catch (x) { setErr(errMsg(x)); }
  }
  if (done) return <main className="auth"><div className="card stack"><h1>Password set</h1><a className="btn primary" href="/login">Continue to sign in</a></div></main>;
  return (
    <main className="auth"><form className="card stack" onSubmit={submit}>
      <h1>Set your password</h1>
      {err && <div className="banner err" role="alert">{err}</div>}
      <label>New password (10+ characters)<input type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <label>Confirm password<input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      <button className="btn primary">Save password</button>
    </form></main>
  );
}
export default function Page() { return <Suspense><Form /></Suspense>; }
