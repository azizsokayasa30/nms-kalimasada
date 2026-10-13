import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { AlarmsPage } from './pages/Alarms';
import { DashboardPage } from './pages/Dashboard';
import { DeviceDetailPage } from './pages/DeviceDetail';
import { DeviceFormPage } from './pages/DeviceForm';
import { DevicesPage } from './pages/Devices';
import { LoginPage } from './pages/Login';
import { SettingsPage } from './pages/Settings';
import { MrtgPage } from './pages/Mrtg';
import { TopologyPage } from './pages/Topology';

function Private({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="empty">Memuat sesi...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/topology/layar" element={<Private><TopologyPage present /></Private>} />
      <Route path="/" element={<Private><Layout /></Private>}>
        <Route index element={<DashboardPage />} />
        <Route path="topology" element={<TopologyPage />} />
        <Route path="mrtg" element={<MrtgPage />} />
        <Route path="mrtg/:id" element={<MrtgPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/new" element={<DeviceFormPage />} />
        <Route path="devices/:id/edit" element={<DeviceFormPage />} />
        <Route path="devices/:id" element={<DeviceDetailPage />} />
        <Route path="alarms" element={<AlarmsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="users" element={<Navigate to="/settings?tab=pengguna" replace />} />
      </Route>
    </Routes>
  );
}
