import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Alarm = {
  id: string;
  severity: string;
  kind: string;
  status: string;
  acknowledgedAt: string | null;
};
type Settings = { soundEnabled: boolean; soundName: string | null; recoverySoundName?: string | null; soundVolume?: number };

const REPEAT_MS = 3500;

export function AlarmSound({ muted }: { muted: boolean }) {
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const tone = useRef<AudioContext | null>(null);
  const file = useRef<HTMLAudioElement | null>(null);
  const fileUrl = useRef<string | null>(null);
  const fileName = useRef<string | null>(null);
  const shouldRing = useRef(false);
  const volumeRef = useRef(0.8);
  const pollGeneration = useRef(0);
  const loopOn = useRef(false);
  const loopTimer = useRef<number | undefined>(undefined);
  const downIds = useRef<Set<string> | null>(null);
  const chimed = useRef(new Set<string>());
  const recoveryFile = useRef<{ name: string; url: string } | null>(null);

  function dropRecoveryFile() {
    if (recoveryFile.current) URL.revokeObjectURL(recoveryFile.current.url);
    recoveryFile.current = null;
  }

  async function playUp(name: string | null | undefined, volume: number) {
    if (name) {
      try {
        if (recoveryFile.current?.name !== name) {
          const response = await fetch('/api/settings/recovery-sound', { headers: authHeaders() });
          if (response.ok) {
            dropRecoveryFile();
            recoveryFile.current = { name, url: URL.createObjectURL(await response.blob()) };
          }
        }
        if (recoveryFile.current?.name === name) {
          const player = new Audio(recoveryFile.current.url);
          player.volume = volume;
          await player.play();
          return;
        }
      } catch {
        // File gagal diputar, pakai nada bawaan.
      }
    }
    const ctx = toneContext();
    if (ctx.state === 'running') playRecovery(ctx, volume);
  }

  function toneContext() {
    if (!tone.current || tone.current.state === 'closed') tone.current = new AudioContext();
    return tone.current;
  }

  function stopFile() {
    if (!file.current) return;
    file.current.pause();
    file.current.currentTime = 0;
  }

  function stopTone() {
    loopOn.current = false;
    if (loopTimer.current) window.clearTimeout(loopTimer.current);
    loopTimer.current = undefined;
  }

  function stopLoop() {
    stopTone();
    stopFile();
  }

  async function loadFile(name: string) {
    if (fileName.current === name && file.current) return true;
    const token = localStorage.getItem('token');
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch('/api/settings/alarm-sound', { headers });
    if (!response.ok) return false;
    const blob = await response.blob();
    if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
    fileUrl.current = URL.createObjectURL(blob);
    const player = file.current ?? new Audio();
    player.pause();
    player.src = fileUrl.current;
    player.loop = true;
    player.volume = volumeRef.current;
    file.current = player;
    fileName.current = name;
    return true;
  }

  function startTone() {
    if (loopOn.current) return;
    loopOn.current = true;
    const step = () => {
      if (!shouldRing.current || fileName.current) {
        stopTone();
        if (!shouldRing.current) setNeedsUnlock(false);
        return;
      }
      const ctx = toneContext();
      if (ctx.state !== 'running') {
        setNeedsUnlock(true);
        loopTimer.current = window.setTimeout(step, 1000);
        return;
      }
      setNeedsUnlock(false);
      playAlarm(ctx, volumeRef.current);
      loopTimer.current = window.setTimeout(step, REPEAT_MS);
    };
    step();
  }

  async function startFile(name: string) {
    stopTone();
    const ready = await loadFile(name).catch(() => false);
    if (!ready || !shouldRing.current || !file.current) {
      fileName.current = null;
      startTone();
      return;
    }
    file.current.volume = volumeRef.current;
    if (!file.current.paused) return;
    try {
      await file.current.play();
      setNeedsUnlock(false);
    } catch {
      setNeedsUnlock(true);
    }
  }

  async function unlock() {
    const ctx = toneContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (shouldRing.current && file.current) {
      try {
        await file.current.play();
      } catch {
        // Nada file tetap menunggu klik berikutnya.
      }
    } else if (shouldRing.current) {
      startTone();
    }
    const playing = Boolean(file.current && !file.current.paused) || ctx.state === 'running';
    setNeedsUnlock(shouldRing.current && !playing);
  }

  useEffect(() => {
    const onGesture = () => {
      void unlock();
    };
    window.addEventListener('pointerdown', onGesture);
    window.addEventListener('keydown', onGesture);
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
      stopLoop();
      if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
      dropRecoveryFile();
      void tone.current?.close();
      tone.current = null;
    };
  }, []);

  useEffect(() => {
    const generation = pollGeneration.current + 1;
    pollGeneration.current = generation;
    let pollTimer: number | undefined;
    let polling = false;
    let queued = false;

    async function poll() {
      if (pollGeneration.current !== generation) return;
      if (polling) {
        queued = true;
        return;
      }
      polling = true;
      if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      try {
        const [alarms, settings] = await Promise.all([
          api<Alarm[]>('/api/alarms'),
          api<Settings>('/api/settings'),
        ]);
        if (pollGeneration.current !== generation) return;
        const down = alarms.some(
          (alarm) => !alarm.acknowledgedAt && (alarm.kind === 'down' || alarm.status === 'down'),
        );
        const volume = Math.min(100, Math.max(0, Number(settings.soundVolume ?? 80))) / 100;
        volumeRef.current = volume;
        const audible = !muted && settings.soundEnabled && volume > 0;
        const previous = downIds.current;
        const current = new Set(alarms.filter((alarm) => alarm.kind === 'down').map((alarm) => alarm.id));
        downIds.current = current;
        const gone = previous ? [...previous].filter((id) => !current.has(id) && !chimed.current.has(id)) : [];
        shouldRing.current = audible && down;
        if (!shouldRing.current) {
          stopLoop();
          setNeedsUnlock(false);
        }
        if (gone.length) {
          const history = await api<Alarm[]>('/api/alarms?state=history');
          if (pollGeneration.current !== generation) return;
          const recovered = new Set(history.map((alarm) => alarm.id));
          const up = gone.filter((id) => recovered.has(id));
          up.forEach((id) => chimed.current.add(id));
          if (audible && up.length) void playUp(settings.recoverySoundName, volume);
        }
        if (!shouldRing.current) return;
        if (settings.soundName) await startFile(settings.soundName);
        else {
          stopFile();
          fileName.current = null;
          startTone();
        }
      } catch {
        // Suara tidak boleh menjatuhkan dashboard.
      } finally {
        polling = false;
        if (pollGeneration.current !== generation) return;
        if (queued) {
          queued = false;
          void poll();
          return;
        }
        pollTimer = window.setTimeout(() => void poll(), 5000);
      }
    }

    void poll();
    const onStatus = () => {
      void poll();
    };
    const onSound = () => {
      fileName.current = null;
      dropRecoveryFile();
      void poll();
    };
    window.addEventListener('noc-refresh', onStatus);
    window.addEventListener('alarm-sound-changed', onSound);
    return () => {
      pollGeneration.current += 1;
      shouldRing.current = false;
      stopLoop();
      if (pollTimer) window.clearTimeout(pollTimer);
      window.removeEventListener('noc-refresh', onStatus);
      window.removeEventListener('alarm-sound-changed', onSound);
    };
  }, [muted]);

  if (!needsUnlock) return null;
  return (
    <button className="sound-unlock" type="button" onClick={() => void unlock()}>
      Ada perangkat DOWN. Klik untuk menyalakan suara alarm.
    </button>
  );
}

function authHeaders() {
  const headers = new Headers();
  const token = localStorage.getItem('token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

function playAlarm(context: AudioContext, volume: number) {
  const level = Math.max(0.0002, 0.18 * volume);
  const now = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(level, now + 0.02);
  gain.gain.setValueAtTime(level, now + 0.7);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  gain.connect(context.destination);
  [880, 660, 880].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    const start = now + index * 0.24;
    oscillator.start(start);
    oscillator.stop(start + 0.18);
  });
}

export function playRecovery(context: AudioContext, volume: number) {
  const level = Math.max(0.0002, 0.16 * volume);
  const now = context.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    const start = now + index * 0.13;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (index === 3 ? 0.7 : 0.3));
    gain.connect(context.destination);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(start + (index === 3 ? 0.72 : 0.32));
  });
}
