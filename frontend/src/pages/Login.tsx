import '@fontsource-variable/plus-jakarta-sans';
import { FormEvent, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

type Health = { api: string; database: string; zabbix: string; zabbixVersion?: string | null };

const features = [
  { title: 'Status realtime', text: 'Ping, latency, dan packet loss setiap perangkat.' },
  { title: 'Alarm instan', text: 'Suara, popup, dan notifikasi saat perangkat DOWN.' },
  { title: 'Topologi & MRTG', text: 'Peta jaringan dan grafik trafik interface.' },
];

export function LoginPage() {
  const { user, login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null | 'down'>(null);

  useEffect(() => {
    let alive = true;
    api<Health>('/api/health')
      .then((value) => { if (alive) setHealth(value); })
      .catch(() => { if (alive) setHealth('down'); });
    return () => { alive = false; };
  }, []);

  if (user) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(identifier, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login gagal');
    } finally {
      setBusy(false);
    }
  }

  const online = health && health !== 'down' && health.api === 'up' && health.database === 'up';
  const statusText = health === null
    ? 'Memeriksa layanan...'
    : online
      ? `Layanan aktif${health.zabbix === 'up' && health.zabbixVersion ? ` · Zabbix ${health.zabbixVersion}` : ''}`
      : 'Layanan sedang bermasalah';

  return (
    <div className="auth">
      <section className="auth-brand" aria-hidden="true">
        <svg className="auth-pulse" viewBox="0 0 600 120" preserveAspectRatio="none">
          <path d="M0 60 H210 L235 60 L250 22 L270 100 L290 38 L305 60 H600" />
        </svg>
        <div className="auth-brand-inner">
          <div className="auth-logo-wrap">
            <img className="auth-logo" src="/icon-512.png" alt="" />
          </div>
          <div className="auth-wordmark">KALIMASADA</div>
          <div className="auth-tagline">Network Monitoring System</div>
          <ul className="auth-features">
            {features.map((item) => (
              <li key={item.title}>
                <span className="auth-dot" />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <footer className="auth-brand-foot">© {new Date().getFullYear()} Kalimasada · Ruang NOC</footer>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-mobile-brand">
            <img src="/icon-192.png" alt="" />
            <div>
              <div className="auth-wordmark sm">KALIMASADA</div>
              <div className="auth-tagline sm">Network Monitoring System</div>
            </div>
          </div>

          <h1>Selamat datang</h1>
          <p className="auth-lead">Masuk untuk memantau jaringan Anda.</p>

          <form onSubmit={(event) => void submit(event)} noValidate>
            <label className="auth-field">
              <span>Email atau nama</span>
              <div className="auth-input">
                <UserIcon />
                <input
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  placeholder="nama@kalimasada-app.com"
                  autoFocus
                  required
                />
              </div>
            </label>
            <label className="auth-field">
              <span>Password</span>
              <div className="auth-input">
                <LockIcon />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  className="auth-eye"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </label>
            {error ? <div className="auth-error" role="alert">{error}</div> : null}
            <button className="auth-submit" type="submit" disabled={busy || !identifier || !password}>
              {busy ? <span className="auth-spinner" aria-hidden="true" /> : null}
              {busy ? 'Masuk...' : 'Masuk'}
            </button>
          </form>

          <div className={`auth-status ${health === null ? 'pending' : online ? 'up' : 'down'}`}>
            <i />
            {statusText}
          </div>
        </div>
      </section>
    </div>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-3.6 4.4-5.4 8-5.4s6.5 1.8 8 5.4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4l16 16" />
      <path d="M9.9 5.8A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 3.9M6.3 7.6C3.9 9.3 2.5 12 2.5 12S6 18.5 12 18.5c1.5 0 2.9-.4 4.1-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
