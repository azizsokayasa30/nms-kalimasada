import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export type SessionUser = { id: string; email: string; name: string; role: string };

type AuthValue = {
  user: SessionUser | null;
  ready: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
  replaceUser: (next: SessionUser) => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => {
    const raw = localStorage.getItem('user');
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setReady(true);
      return;
    }
    api<{ sub: string; email: string; name: string; role: string }>('/api/auth/me')
      .then((me) => {
        const next = { id: me.sub, email: me.email, name: me.name, role: me.role };
        localStorage.setItem('user', JSON.stringify(next));
        setUser(next);
      })
      .catch(() => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
      })
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      ready,
      async login(identifier, password) {
        const result = await api<{ accessToken: string; user: SessionUser }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ login: identifier, password }),
        });
        localStorage.setItem('token', result.accessToken);
        localStorage.setItem('user', JSON.stringify(result.user));
        setUser(result.user);
      },
      logout() {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
      },
      replaceUser(next) {
        localStorage.setItem('user', JSON.stringify(next));
        setUser(next);
      },
    }),
    [user, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth belum siap');
  return value;
}
