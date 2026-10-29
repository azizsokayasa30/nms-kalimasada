import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api } from '../lib/api';
import { DISPLAY_EVENT, MUTE_EVENT, applyDisplay, readMuted, readRefreshSeconds, saveDisplay, saveMuted } from '../lib/display';
import { roleLabels } from '../lib/format';
import { useAuth } from '../lib/auth';
import { AlarmPopup } from './AlarmPopup';
import { AlarmSound } from './AlarmSound';
import { PageFind, isFindPage } from './PageFind';

const links: Array<{ to: string; label: string; end?: boolean; icon: ReactNode; alarms?: boolean }> = [
  { to: '/', label: 'Dashboard', end: true, icon: <HomeIcon /> },
  { to: '/devices', label: 'Devices', icon: <DevicesIcon /> },
  { to: '/topology', label: 'Topology', icon: <TopologyIcon /> },
  { to: '/alarms', label: 'Alarms', icon: <BellIcon />, alarms: true },
  { to: '/mrtg', label: 'MRTG', icon: <ChartIcon /> },
  { to: '/settings', label: 'Settings', icon: <GearIcon /> },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [muted, setMuted] = useState(readMuted);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeAlarms, setActiveAlarms] = useState(0);
  const activeLink = links.find((link) => (link.end ? pathname === link.to : pathname.startsWith(link.to)));

  useEffect(() => {
    const load = () => {
      void api<{ activeAlarms: number }>('/api/dashboard')
        .then((summary) => setActiveAlarms(summary.activeAlarms))
        .catch(() => undefined);
    };
    load();
    window.addEventListener('noc-refresh', load);
    return () => window.removeEventListener('noc-refresh', load);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('menu-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('menu-open');
    };
  }, [menuOpen]);

  useEffect(() => {
    const sync = () => {
      applyDisplay();
      setDark(document.documentElement.dataset.theme === 'dark');
      setMuted(readMuted());
    };
    sync();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener(DISPLAY_EVENT, sync);
    window.addEventListener(MUTE_EVENT, sync);
    media.addEventListener('change', sync);
    return () => {
      window.removeEventListener(DISPLAY_EVENT, sync);
      window.removeEventListener(MUTE_EVENT, sync);
      media.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    let timer = window.setInterval(() => window.dispatchEvent(new Event('noc-refresh')), readRefreshSeconds() * 1000);
    const reset = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => window.dispatchEvent(new Event('noc-refresh')), readRefreshSeconds() * 1000);
    };
    window.addEventListener(DISPLAY_EVENT, reset);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(DISPLAY_EVENT, reset);
    };
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const socket = io({ path: '/socket.io', auth: { token } });
    const refresh = () => window.dispatchEvent(new Event('noc-refresh'));
    socket.on('device_status_changed', refresh);
    socket.on('alarm_created', refresh);
    socket.on('alarm_recovered', refresh);
    return () => {
      socket.close();
    };
  }, [user?.id]);

  return (
    <div className="shell">
      <header className="mobile-bar">
        <button
          type="button"
          className="menu-toggle"
          aria-label="Buka menu"
          aria-expanded={menuOpen}
          aria-controls="app-sidebar"
          onClick={() => setMenuOpen(true)}
        >
          <MenuIcon />
        </button>
        <img className="brand-logo" src="/icon-192.png" alt="" />
        <div className="brand">
          <strong>Kalimasada</strong>
          <span>{activeLink?.label ?? 'Network monitoring'}</span>
        </div>
      </header>
      {menuOpen ? <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" /> : null}
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'} id="app-sidebar">
        <div className="sidebar-head">
          <div className="brand-row">
            <img className="brand-logo" src="/icon-192.png" alt="" />
            <div className="brand">
              <strong>Kalimasada</strong>
              <span>Monitoring System</span>
            </div>
          </div>
          <button type="button" className="menu-close" aria-label="Tutup menu" onClick={() => setMenuOpen(false)}>
            <CloseIcon />
          </button>
        </div>
        <nav className="nav">
          {links.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {link.icon}
              <span>{link.label}</span>
              {link.alarms && activeAlarms > 0 ? <b className="nav-badge">{activeAlarms}</b> : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-tools">
          <button
            type="button"
            className="icon-btn"
            title={muted ? 'Suara mati' : 'Suara hidup'}
            aria-label={muted ? 'Suara mati' : 'Suara hidup'}
            aria-pressed={!muted}
            onClick={() => saveMuted(!muted)}
          >
            {muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={dark ? 'Mode terang' : 'Mode gelap'}
            aria-label={dark ? 'Mode terang' : 'Mode gelap'}
            onClick={() => saveDisplay({ theme: dark ? 'light' : 'dark' })}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
        <div className="user">
          <div className="user-card">
            <span className="avatar" aria-hidden="true">{initials(user?.name)}</span>
            <div>
              <strong className="user-name" title={user?.name}>{user?.name}</strong>
              <span className="user-role">{roleLabels[user?.role ?? ''] ?? user?.role}</span>
            </div>
          </div>
          <button className="logout" type="button" onClick={() => { logout(); navigate('/login'); }}>Keluar</button>
        </div>
      </aside>
      <section className="main">
        <header className="topbar">
          {isFindPage(pathname) ? (
            <PageFind key={pathname} />
          ) : (
            <div className="topbar-title">
              <h1>{activeLink?.label}</h1>
              {pathname === '/' ? <p>Ringkasan real-time infrastruktur jaringan</p> : null}
            </div>
          )}
          <div id="topbar-slot" className="topbar-slot" />
          <div className="topbar-actions">
            <Link to="/alarms" className="topbar-bell" title="Alarm aktif" aria-label={`Alarm aktif: ${activeAlarms}`}>
              <BellIcon />
              {activeAlarms > 0 ? <b className="count">{activeAlarms}</b> : null}
            </Link>
          </div>
        </header>
        <div className="content" id="page-content">
          <Outlet />
        </div>
      </section>
      <AlarmSound muted={muted} />
      <AlarmPopup />
    </div>
  );
}

function initials(name?: string) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

function NavSvg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function HomeIcon() {
  return (
    <NavSvg>
      <rect x="3" y="3" width="7.5" height="9" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="2" />
      <rect x="13.5" y="11" width="7.5" height="10" rx="2" />
      <rect x="3" y="15" width="7.5" height="6" rx="2" />
    </NavSvg>
  );
}

function DevicesIcon() {
  return (
    <NavSvg>
      <rect x="3" y="13" width="18" height="7.5" rx="2.5" />
      <path d="M7 16.75h.01M10.5 16.75h.01M14.5 16.75H17" />
      <path d="M12 13v-3" />
      <path d="M8.8 7.6a4.5 4.5 0 0 1 6.4 0" />
      <path d="M6.3 5.1a8 8 0 0 1 11.4 0" />
    </NavSvg>
  );
}

function TopologyIcon() {
  return (
    <NavSvg>
      <rect x="9" y="2.5" width="6" height="6" rx="1.75" />
      <rect x="2.5" y="15.5" width="6" height="6" rx="1.75" />
      <rect x="15.5" y="15.5" width="6" height="6" rx="1.75" />
      <path d="M12 8.5V12M5.5 15.5V13a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v2.5" />
    </NavSvg>
  );
}

function BellIcon() {
  return (
    <NavSvg>
      <path d="M10.3 21a2 2 0 0 0 3.4 0" />
      <path d="M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8a6 6 0 0 0-12 0c0 4.5-1.4 6-2.7 7.3" />
    </NavSvg>
  );
}

function ChartIcon() {
  return (
    <NavSvg>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7" />
    </NavSvg>
  );
}

function GearIcon() {
  return (
    <NavSvg>
      <path d="M20 7h-9M14 17H4" />
      <circle cx="7" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
    </NavSvg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M23 9l-6 6M17 9l6 6" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
