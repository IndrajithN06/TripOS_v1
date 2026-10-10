'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api, useApi } from '@/lib/api';
import { Loading, Me, MeContext, ErrorBox } from '@/components/ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '▦', roles: ['AGENCY_ADMIN', 'SALES'] },
  { href: '/inbox', label: 'WhatsApp Inbox', icon: '✉', roles: ['AGENCY_ADMIN', 'SALES'] },
  { href: '/quotes', label: 'Quotes', icon: '₹', roles: ['AGENCY_ADMIN', 'SALES'] },
  { href: '/vehicles', label: 'Vehicle Types', icon: '🚐', roles: ['AGENCY_ADMIN', 'SALES'] },
  { href: '/settings', label: 'Settings', icon: '⚙', roles: ['AGENCY_ADMIN'] },
  { href: '/platform', label: 'Agencies', icon: '🏢', roles: ['SUPER_ADMIN'] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: me, error } = useApi<Me>('/me');
  const path = usePathname(), router = useRouter();
  useEffect(() => {
    if (!me) return;
    const item = NAV.find((n) => path.startsWith(n.href));
    if (item && !item.roles.includes(me.user.role)) router.replace(me.user.role === 'SUPER_ADMIN' ? '/platform' : '/dashboard');
  }, [me, path, router]);
  if (error?.status === 403) return <main className="auth"><div className="card stack"><h1>Access suspended</h1><p>{error.message}</p><button className="btn" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => (location.href = '/login'))}>Sign out</button></div></main>;
  if (error && error.status !== 401) return <main className="auth"><ErrorBox e={error} /></main>;
  if (!me) return <Loading what="Loading workspace" />;
  const brand = me.agency?.brandColour ?? '#157f58';
  return (
    <MeContext.Provider value={me}>
      <div className="shell" style={{ ['--brand' as string]: brand }}>
        <nav className="nav" aria-label="Main">
          <div className="brand">
            {me.agency?.logoUrl ? <img className="logo" src={me.agency.logoUrl} alt="" /> : <span className="logo">{(me.agency?.name ?? 'T')[0]}</span>}
            <span>{me.agency?.name ?? 'TripOS Platform'}</span>
          </div>
          {NAV.filter((n) => n.roles.includes(me.user.role)).map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''}><span aria-hidden>{n.icon}</span>{n.label}</Link>
          ))}
          <div className="spacer" />
          {me.environment.whatsappSimulated && me.user.role !== 'SUPER_ADMIN' && <div className="who"><span className="sim-tag">SIMULATED WHATSAPP</span></div>}
          <div className="who">{me.user.name}<br />{me.user.role.replace('_', ' ').toLowerCase()}</div>
          <a href="#" onClick={(e) => { e.preventDefault(); void api('/auth/logout', { method: 'POST' }).then(() => (location.href = '/login')); }}>Sign out</a>
        </nav>
        <main className="main">{children}</main>
      </div>
    </MeContext.Provider>
  );
}
