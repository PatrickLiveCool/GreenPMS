import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { AppShell, LoginPage, WorkspaceProvider } from "./session";
import type { PrincipalDto } from "./types";
import { LoadingBlock } from "./ui";
import { InventoryPage } from "./pages/InventoryPage";
import { MembersPage } from "./pages/MembersPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { TodayPage } from "./pages/TodayPage";
import { TokensPage } from "./pages/TokensPage";

export default function App() {
  const [principal, setPrincipal] = useState<PrincipalDto>();
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    api.me().then(setPrincipal).catch(() => setPrincipal(undefined)).finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) return <main className="startup-state"><LoadingBlock label="正在检查登录状态" /></main>;
  if (!principal) return <LoginPage onLogin={setPrincipal} />;

  return (
    <BrowserRouter>
      <WorkspaceProvider principal={principal} onLogout={() => setPrincipal(undefined)}>
        <Routes>
          <Route element={<AppShell onLogout={() => setPrincipal(undefined)} />}>
            <Route index element={<InventoryPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/:orderId" element={<OrderDetailPage />} />
            <Route path="today" element={<TodayPage />} />
            <Route path="tokens" element={<TokensPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </WorkspaceProvider>
    </BrowserRouter>
  );
}
