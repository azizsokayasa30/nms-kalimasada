import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatClock, formatDuration } from '../lib/format';

export type PopupConfig = {
  enabled: boolean;
  events: string[];
  durationSec: number;
  position: 'top-right' | 'bottom-right';
};

type Alarm = {
  id: string;
  title: string;
  kind: string;
  deviceName: string;
  ipAddress: string;
  openedAt: string;
  recoveredAt: string | null;
  downtimeSec: number | null;
};

type Toast = { key: string; event: 'down' | 'warning' | 'recovered'; title: string; detail: string };

export const POPUP_SETTINGS_EVENT = 'notification-settings-changed';
const MAX_TOASTS = 5;

export function AlarmPopup() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<PopupConfig | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const configRef = useRef<PopupConfig | null>(null);
  const known = useRef<Map<string, Alarm> | null>(null);
  const busy = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    const load = () => {
      void api<PopupConfig>('/api/notifications/popup')
        .then((value) => {
          configRef.current = value;
          setConfig(value);
          if (!value.enabled) setToasts([]);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener(POPUP_SETTINGS_EVENT, load);
    return () => window.removeEventListener(POPUP_SETTINGS_EVENT, load);
  }, []);

  useEffect(() => {
    let alive = true;

    async function poll() {
      if (busy.current) {
        again.current = true;
        return;
      }
      busy.current = true;
      try {
        const active = await api<Alarm[]>('/api/alarms');
        if (!alive) return;
        const previous = known.current;
        known.current = new Map(active.map((alarm) => [alarm.id, alarm]));
        const settings = configRef.current;
        if (!previous || !settings?.enabled) return;
        const next: Toast[] = [];
        for (const alarm of active) {
          if (previous.has(alarm.id)) continue;
          const event = alarm.kind === 'down' ? 'down' : 'warning';
          if (!settings.events.includes(event)) continue;
          next.push({
            key: `${alarm.id}:${event}`,
            event,
            title: alarm.title,
            detail: `${alarm.ipAddress} · ${formatClock(alarm.openedAt)}`,
          });
        }
        const gone = [...previous.values()].filter((alarm) => !known.current?.has(alarm.id));
        if (gone.length && settings.events.includes('recovered')) {
          const history = await api<Alarm[]>('/api/alarms?state=history');
          const recovered = new Map(history.map((alarm) => [alarm.id, alarm]));
          for (const alarm of gone) {
            const row = recovered.get(alarm.id);
            if (!row) continue;
            next.push({
              key: `${alarm.id}:recovered`,
              event: 'recovered',
              title: `${row.deviceName} pulih`,
              detail: `${row.ipAddress} · downtime ${formatDuration(row.downtimeSec ?? 0)}`,
            });
          }
        }
        if (alive && next.length) {
          setToasts((current) => {
            const keys = new Set(current.map((toast) => toast.key));
            return [...next.filter((toast) => !keys.has(toast.key)), ...current].slice(0, MAX_TOASTS);
          });
        }
      } catch {
        // Popup tidak boleh mengganggu dashboard.
      } finally {
        busy.current = false;
        if (again.current && alive) {
          again.current = false;
          void poll();
        }
      }
    }

    void poll();
    const onRefresh = () => void poll();
    window.addEventListener('noc-refresh', onRefresh);
    return () => {
      alive = false;
      window.removeEventListener('noc-refresh', onRefresh);
    };
  }, []);

  if (!config?.enabled || !toasts.length) return null;
  const close = (key: string) => setToasts((current) => current.filter((toast) => toast.key !== key));

  return (
    <div className={`alarm-popups ${config.position}`} role="status" aria-live="assertive">
      {toasts.map((toast) => (
        <PopupItem
          key={toast.key}
          toast={toast}
          durationSec={config.durationSec}
          onClose={() => close(toast.key)}
          onOpen={() => {
            close(toast.key);
            navigate('/alarms');
          }}
        />
      ))}
    </div>
  );
}

const labels: Record<Toast['event'], string> = { down: 'DOWN', warning: 'WARNING', recovered: 'UP' };

function PopupItem({ toast, durationSec, onClose, onOpen }: { toast: Toast; durationSec: number; onClose: () => void; onOpen: () => void }) {
  useEffect(() => {
    if (durationSec <= 0) return;
    const timer = window.setTimeout(onClose, durationSec * 1000);
    return () => window.clearTimeout(timer);
  }, [durationSec]);

  return (
    <div className={`alarm-popup ${toast.event}`}>
      <button className="alarm-popup-body" type="button" onClick={onOpen}>
        <span className="alarm-popup-tag">{labels[toast.event]}</span>
        <strong>{toast.title}</strong>
        <span className="alarm-popup-detail">{toast.detail}</span>
      </button>
      <button className="alarm-popup-close" type="button" aria-label="Tutup" onClick={onClose}>×</button>
    </div>
  );
}
