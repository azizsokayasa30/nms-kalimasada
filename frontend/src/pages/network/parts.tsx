import { FormEvent, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { formatBps } from '../../lib/format';
import { stateLabels, stateTone, type Iface, type LinkState, type TestRequest, type Traffic } from './model';

export function StateBadge({ state, text }: { state: LinkState; text?: string | null }) {
  return (
    <span className={`badge ${stateTone[state]}`} title={text ?? undefined}>
      <i />
      {stateLabels[state]}
    </span>
  );
}

export function Rates({ rx, tx }: { rx: Traffic; tx: Traffic }) {
  return (
    <span className="net-rate">
      <span title="Masuk (RX)">↓ {formatBps(rx.bps)}</span>
      <span title="Keluar (TX)">↑ {formatBps(tx.bps)}</span>
    </span>
  );
}

export function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={on ? 'net-switch on' : 'net-switch'}
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

type TestResult = {
  target: string;
  ip: string;
  iface: string | null;
  route: { dev: string | null; gateway: string | null; src: string | null } | null;
  routeError: string | null;
  ping: { sent: number; received: number; lossPct: number; min: number | null; avg: number | null; max: number | null; replies: number[]; error: string | null };
  tcp: { port: number; ok: boolean; ms: number | null; error: string | null } | null;
};

export function TestPanel({ request, interfaces, onClose }: { request: TestRequest; interfaces: Iface[]; onClose: () => void }) {
  const [target, setTarget] = useState(request.target);
  const [iface, setIface] = useState(request.iface);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState('');

  async function execute(nextTarget: string, nextIface: string, nextPort: string) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api<TestResult>('/api/network/test', {
        method: 'POST',
        body: JSON.stringify({ target: nextTarget, iface: nextIface || undefined, port: nextPort ? Number(nextPort) : undefined }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tes gagal');
    } finally {
      setBusy(false);
    }
  }

  function run(event: FormEvent) {
    event.preventDefault();
    if (target.trim()) void execute(target.trim(), iface, port);
  }

  useEffect(() => {
    setTarget(request.target);
    setIface(request.iface);
    setPort('');
    if (request.target) void execute(request.target, request.iface, '');
    else setResult(null);
  }, [request]);

  const ok = result && result.ping.received > 0;
  const partial = ok && result.ping.received < result.ping.sent;
  const max = Math.max(1, ...(result?.ping.replies ?? [1]));

  return (
    <div className="net-test">
      <form className="net-test-form" onSubmit={run}>
        <strong>Tes koneksi</strong>
        <input value={target} placeholder="IP / host tujuan" onChange={(event) => setTarget(event.target.value)} autoFocus />
        <select value={iface} onChange={(event) => setIface(event.target.value)} title="Lewat interface">
          <option value="">Otomatis</option>
          {interfaces.map((item) => <option key={item.name} value={item.name}>{item.name}{item.label ? ` · ${item.label}` : ''}</option>)}
        </select>
        <input className="net-port" value={port} inputMode="numeric" placeholder="Port TCP" onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} />
        <button className="btn" type="submit" disabled={busy || !target.trim()}>{busy ? 'Menguji…' : 'Tes'}</button>
        <button className="btn-ghost" type="button" onClick={onClose} aria-label="Tutup">✕</button>
      </form>
      {error ? <div className="net-test-result bad">{error}</div> : null}
      {result ? (
        <div className={`net-test-result ${ok ? (partial ? 'warn' : 'ok') : 'bad'}`}>
          <div className="net-test-head">
            <b>{ok ? (partial ? 'Sebagian terjawab' : 'Terhubung') : 'Tidak ada balasan'}</b>
            <span>{result.ping.received}/{result.ping.sent} balasan</span>
            {result.ping.avg != null ? <span>rata-rata {result.ping.avg.toFixed(1)} ms</span> : null}
            {result.ping.min != null ? <span>min {result.ping.min.toFixed(1)} · max {result.ping.max?.toFixed(1)} ms</span> : null}
            {result.ping.lossPct > 0 ? <span>loss {result.ping.lossPct}%</span> : null}
          </div>
          <div className="net-test-meta">
            <span>{result.ip !== result.target ? `${result.target} → ${result.ip}` : result.ip}</span>
            {result.route ? (
              <span>lewat <b>{result.route.dev}</b>{result.route.gateway ? ` via ${result.route.gateway}` : ''}{result.route.src ? ` · src ${result.route.src}` : ''}</span>
            ) : <span>{result.routeError ?? 'Tidak ada rute'}</span>}
            {result.tcp ? (
              <span className={result.tcp.ok ? 'status-ok' : 'status-bad'}>
                Port {result.tcp.port} {result.tcp.ok ? `terbuka (${result.tcp.ms?.toFixed(0)} ms)` : `— ${result.tcp.error}`}
              </span>
            ) : null}
            {result.ping.error ? <span className="status-bad">{result.ping.error}</span> : null}
          </div>
          {result.ping.replies.length ? (
            <div className="net-bars" aria-hidden="true">
              {result.ping.replies.map((ms, index) => <i key={index} style={{ height: `${Math.max(12, (ms / max) * 100)}%` }} title={`${ms} ms`} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
