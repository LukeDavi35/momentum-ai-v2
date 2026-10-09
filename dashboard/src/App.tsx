import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, AuthError, getToken, setToken } from "./api";
import type { Overview } from "./types";
import { AlertsView, AnalyticsView, ContentView, HeldView, LearningView, PublishedView, SpendView, StatusView } from "./views";

const TABS = ["Status", "Content", "Held", "Published", "Analytics", "Spend", "Learning", "Alerts"] as const;
type Tab = (typeof TABS)[number];

function Login({ onDone, message }: { onDone: () => void; message?: string }): ReactNode {
  const [t, setT] = useState("");
  return (
    <div className="login card">
      <h2>Momentum control room</h2>
      <p className="muted">{message ?? "Enter the admin token (ADMIN_TOKEN on the server). It is kept for this browser tab only."}</p>
      <input type="password" value={t} onChange={(e) => setT(e.target.value)} placeholder="Admin token" autoFocus onKeyDown={(e) => e.key === "Enter" && (setToken(t.trim()), onDone())} />
      <button className="btn safe" onClick={() => (setToken(t.trim()), onDone())}>Open</button>
    </div>
  );
}

export function App(): ReactNode {
  const [authed, setAuthed] = useState(() => getToken() !== "");
  const [tab, setTab] = useState<Tab>("Status");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Overview>("/api/overview").then((o) => (setOverview(o), setError(null))).catch((e) => {
      if (e instanceof AuthError) (setToken(""), setAuthed(false));
      else setError(String(e.message ?? e));
    });
  }, []);
  useEffect(() => {
    if (!authed) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [authed, load]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const toggle = async () => {
    if (!overview) return;
    const engage = !overview.killSwitch.active;
    const msg = engage ? "PAUSE all publishing immediately? Queued posts will wait until you resume." : "Resume publishing?";
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await api("/api/killswitch", { method: "POST", body: JSON.stringify({ active: engage, reason: engage ? "paused from dashboard" : undefined }) });
      load();
    } finally {
      setBusy(false);
    }
  };

  const ks = overview?.killSwitch;
  return (
    <>
      {ks?.active && <div className="banner bad">PUBLISHING PAUSED — kill switch is on ({ks.source}). Nothing will be posted.</div>}
      {overview?.dryRun && <div className="banner info">DRY RUN — the whole pipeline runs, but nothing is sent to TikTok, Instagram or YouTube.</div>}
      <header className="top">
        <h1>MOMENTUM · control room</h1>
        <span className="spacer" />
        {ks && (
          <button className={`btn ${ks.active ? "safe" : "danger"}`} disabled={busy || ks.source === "env"} onClick={toggle} title={ks.source === "env" ? "Set by KILL_SWITCH=true in the environment; change it there." : ""}>
            {ks.active ? "Resume publishing" : "Pause all publishing"}
          </button>
        )}
        <button className="btn" onClick={() => (setToken(""), setAuthed(false))}>Sign out</button>
      </header>
      <nav className="tabs">{TABS.map((t) => <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
      <main>
        {error && <div className="verdict bad">Can't reach the server: {error}</div>}
        {tab === "Status" && (overview ? <StatusView overview={overview} /> : <div className="muted">Loading…</div>)}
        {tab === "Content" && <ContentView />}
        {tab === "Held" && <HeldView />}
        {tab === "Published" && <PublishedView />}
        {tab === "Analytics" && <AnalyticsView />}
        {tab === "Spend" && <SpendView />}
        {tab === "Learning" && <LearningView />}
        {tab === "Alerts" && <AlertsView />}
      </main>
    </>
  );
}
