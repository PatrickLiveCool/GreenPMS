import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { BadgeCheck, BedDouble, Building2, ClipboardList, KeyRound, LogOut, Smartphone, UserRound } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "./api";
import type { MetaDto, PendingTokenCommand, PrincipalDto, RetainedTokenSecret } from "./types";
import { errorMessage, InlineError, LoadingBlock } from "./ui";

interface WorkspaceContextValue {
  principal: PrincipalDto;
  meta: MetaDto;
  propertyId: string;
  setPropertyId: (propertyId: string) => void;
  refreshMeta: () => Promise<void>;
  retainedTokenSecret: RetainedTokenSecret | undefined;
  setRetainedTokenSecret: Dispatch<SetStateAction<RetainedTokenSecret | undefined>>;
  pendingTokenCommand: PendingTokenCommand | undefined;
  setPendingTokenCommand: Dispatch<SetStateAction<PendingTokenCommand | undefined>>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}

export function LoginPage({ onLogin }: { onLogin: (principal: PrincipalDto) => void }) {
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("demo-pass-2026");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const errorRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await api.login(username, password));
    } catch (nextError) {
      setError(nextError);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-word">QinTopia</span>
          <span>PMS Core Operations</span>
        </div>
        <div>
          <p className="eyebrow">运营工作台</p>
          <h1 id="login-title">登录</h1>
        </div>
        {error ? (
          <div className="inline-error" role="alert" tabIndex={-1} ref={errorRef}>
            <div><strong>登录失败</strong><p>{errorMessage(error)}</p></div>
          </div>
        ) : null}
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">账号</label>
          <input id="username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus data-testid="login-username" />
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required data-testid="login-password" />
          <button className="button button-primary login-submit" type="submit" disabled={busy} data-testid="login-submit">{busy ? "正在登录..." : "进入工作台"}</button>
        </form>
        <div className="demo-account" aria-label="演示账号">
          <span>演示账号</span>
          <code>operator</code>
          <code>demo-pass-2026</code>
        </div>
      </section>
    </main>
  );
}

export function WorkspaceProvider({ principal, onLogout, children }: {
  principal: PrincipalDto;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [meta, setMeta] = useState<MetaDto>();
  const [propertyId, setPropertyIdState] = useState("");
  const [error, setError] = useState<unknown>();
  const [retainedTokenSecret, setRetainedTokenSecret] = useState<RetainedTokenSecret>();
  const [pendingTokenCommand, setPendingTokenCommand] = useState<PendingTokenCommand>();

  async function refreshMeta() {
    const nextMeta = await api.meta();
    setMeta(nextMeta);
    setPropertyIdState((current) => {
      if (current && nextMeta.properties.some((property) => property.id === current)) return current;
      const saved = localStorage.getItem("qintopia.propertyId");
      if (saved && nextMeta.properties.some((property) => property.id === saved)) return saved;
      return nextMeta.properties[0]?.id ?? "";
    });
  }

  useEffect(() => {
    void refreshMeta().catch(setError);
  }, []);

  function setPropertyId(nextPropertyId: string) {
    localStorage.setItem("qintopia.propertyId", nextPropertyId);
    setPropertyIdState(nextPropertyId);
  }

  const value = useMemo<WorkspaceContextValue | undefined>(() => meta && propertyId ? ({
    principal,
    meta,
    propertyId,
    setPropertyId,
    refreshMeta,
    retainedTokenSecret,
    setRetainedTokenSecret,
    pendingTokenCommand,
    setPendingTokenCommand
  }) : undefined, [meta, pendingTokenCommand, principal, propertyId, retainedTokenSecret]);

  if (error) {
    return <main className="startup-state"><InlineError error={error} title="无法载入工作区" /><button className="button button-secondary" type="button" onClick={onLogout}>返回登录</button></main>;
  }
  if (!value) return <main className="startup-state"><LoadingBlock label="正在载入运营数据" /></main>;

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

const navigation = [
  { to: "/", label: "房态", icon: BedDouble, end: true },
  { to: "/orders", label: "订单", icon: ClipboardList, end: false },
  { to: "/members", label: "会员", icon: BadgeCheck, end: false },
  { to: "/tokens", label: "Token", icon: KeyRound, end: false },
  { to: "/today", label: "移动履约", icon: Smartphone, end: false }
] as const;

function Navigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={mobile ? "mobile-navigation" : "primary-navigation"} aria-label={mobile ? "移动主导航" : "主导航"}>
      {navigation.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Icon aria-hidden="true" size={mobile ? 20 : 18} />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function AppShell({ onLogout }: { onLogout: () => void }) {
  const { principal, meta, propertyId, setPropertyId } = useWorkspace();
  const property = meta.properties.find((item) => item.id === propertyId);

  async function logout() {
    try {
      await api.logout();
    } finally {
      onLogout();
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳至主要内容</a>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-word">QinTopia</span>
          <span>PMS</span>
        </div>
        <Navigation />
        <div className="sidebar-user">
          <UserRound aria-hidden="true" size={18} />
          <div><strong>{principal.displayName}</strong><span>{principal.propertyAccess[propertyId] ?? "READ"}</span></div>
          <button className="icon-button" type="button" onClick={() => void logout()} aria-label="退出登录" title="退出登录"><LogOut aria-hidden="true" size={18} /></button>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <div className="property-control">
            <Building2 aria-hidden="true" size={17} />
            <label className="sr-only" htmlFor="property-select">门店</label>
            <select id="property-select" value={propertyId} onChange={(event) => setPropertyId(event.target.value)} data-testid="property-select">
              {meta.properties.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
            </select>
          </div>
          <div className="property-meta"><span>{property?.timezone}</span><span>{property?.currency}</span></div>
          <button className="mobile-logout icon-button" type="button" onClick={() => void logout()} aria-label="退出登录" title="退出登录"><LogOut aria-hidden="true" size={19} /></button>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}><Outlet /></main>
      </div>
      <Navigation mobile />
    </div>
  );
}
