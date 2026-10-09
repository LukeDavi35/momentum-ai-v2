import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { computeAttention, verdict } from "./attention";
import { BarChart, Meter } from "./charts";
import type { AlertRow, Analytics, ContentDetail, ContentRow, DlqRow, Held, Overview, Publication, Spend, WeightVersion } from "./types";

const ago = (iso: string | null): string => {
  if (!iso) return "–";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "–");
const STAGES = ["idea", "scripted", "voiced", "rendered", "qa_passed", "scheduled", "published", "measured"];

function useData<T>(path: string, everyMs = 30_000): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<T>(path).then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(String(e.message ?? e)));
    void load();
    const t = setInterval(load, everyMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [path, everyMs]);
  return { data, error };
}
const Loading = ({ error }: { error: string | null }): ReactNode => <div className="muted">{error ? `Could not load: ${error}` : "Loading…"}</div>;
const tone = (s: string): string => (["published", "measured", "qa_passed", "scheduled"].includes(s) ? "ok" : ["held", "failed", "qa_failed"].includes(s) ? "bad" : "warn");

export function StatusView({ overview }: { overview: Overview }): ReactNode {
  const spend = useData<Spend>("/api/spend");
  const dlq = useData<DlqRow[]>("/api/dlq");
  const alerts = useData<AlertRow[]>("/api/alerts?limit=50");
  const attention = computeAttention(overview, spend.data, dlq.data ?? [], alerts.data ?? []);
  const v = verdict(attention);
  return (
    <>
      <div className={`verdict ${v.tone}`}>
        <h2>{v.label}</h2>
        {attention.length === 0 ? <div className="muted">The pipeline is running on its own. Nothing to review.</div> : <ul>{attention.map((a, i) => <li key={i} className={`lvl-${a.level}`}>{a.text}</li>)}</ul>}
      </div>
      <div className="grid">
        <div className="card"><h3>Posts, last 24h</h3><div className="big">{overview.posts24h} <span className="muted">/ {overview.maxPostsPerDay} hard cap</span></div></div>
        <div className="card"><h3>Held for review</h3><div className="big">{overview.contentByStatus.held ?? 0}</div></div>
        <div className="card"><h3>Mode</h3><div className="big">{overview.dryRun ? "Dry run" : "Live"}</div><div className="muted">LLM: {overview.llm}</div></div>
        <div className="card"><h3>Alert channels</h3><div className="big">{overview.alertChannels.length}</div><div className="muted">{overview.alertChannels.join(", ") || "none configured"}</div></div>
      </div>
      <h3 className="sub">Content pipeline</h3>
      <div className="funnel">{STAGES.map((s) => <div key={s}><b>{overview.contentByStatus[s] ?? 0}</b><span className="muted">{s.replace("_", " ")}</span></div>)}</div>
      <h3 className="sub">Queues</h3>
      <div className="card"><table><thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th><th></th></tr></thead><tbody>
        {Object.entries(overview.queues).map(([q, c]) => <tr key={q}><td>{q}</td><td>{c.waiting}</td><td>{c.active}</td><td>{c.delayed}</td><td>{c.failed}</td><td>{c.paused && <span className="pill bad">paused</span>}</td></tr>)}
      </tbody></table></div>
      <h3 className="sub">Connected accounts</h3>
      <div className="card"><table><thead><tr><th>Platform</th><th>Account</th><th>Token expires</th><th>Status</th></tr></thead><tbody>
        {["tiktok", "instagram", "youtube"].map((p) => {
          const a = overview.connectedAccounts.find((x) => x.platform === p);
          return <tr key={p}><td>{p}</td><td>{a?.account_name ?? "–"}</td><td>{a?.expires_at ? when(a.expires_at) : "–"}</td><td>{a ? (a.last_refresh_error ? <span className="pill bad">refresh failing</span> : <span className="pill ok">connected</span>) : <ConnectButton platform={p} />}</td></tr>;
        })}
      </tbody></table></div>
    </>
  );
}

function ConnectButton({ platform }: { platform: string }): ReactNode {
  const [err, setErr] = useState("");
  return (
    <>
      <button className="btn" onClick={() => api<{ url: string }>(`/api/oauth/${platform}/url`).then((r) => (window.location.href = r.url)).catch((e) => setErr(String(e.message)))}>Connect</button>
      {err && <span className="muted"> {err}</span>}
    </>
  );
}

export function ContentView(): ReactNode {
  const [status, setStatus] = useState("");
  const { data, error } = useData<ContentRow[]>(`/api/content?limit=100${status ? `&status=${status}` : ""}`, 15_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="status filter">
        <option value="">All statuses</option>
        {[...STAGES, "qa_failed", "held", "failed"].map((s) => <option key={s}>{s}</option>)}
      </select>
      {!data ? <Loading error={error} /> : (
        <div className="card"><table><thead><tr><th>Topic</th><th>Template</th><th>Pillar</th><th>Status</th><th>Regens</th><th>Updated</th></tr></thead><tbody>
          {data.map((c) => <tr key={c.id} className="click" onClick={() => setOpen(c.id)}><td>{c.topic}{c.generator === "stub" && <span className="pill"> stub</span>}</td><td>{c.template}</td><td>{c.pillar}</td><td><span className={`pill ${tone(c.status)}`}>{c.status}</span></td><td>{c.regen_count}</td><td>{ago(c.status_changed_at)}</td></tr>)}
        </tbody></table>{data.length === 0 && <div className="muted">Nothing here.</div>}</div>
      )}
      {open && <Drawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Drawer({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const { data, error } = useData<ContentDetail>(`/api/content/${id}`, 10_000);
  return (
    <aside className="drawer">
      <button className="btn" onClick={onClose}>Close</button>
      {!data ? <Loading error={error} /> : (
        <>
          <h2>{data.topic}</h2>
          <div className="muted">{data.template} · {data.pillar} · correlation <code>{data.correlation_id.slice(0, 8)}</code></div>
          {data.error && <p><span className="pill bad">{data.error}</span></p>}
          <h3 className="sub">Script</h3>
          {data.script ? data.script.beats.map((b) => <p key={b.id}>{b.text}</p>) : <div className="muted">Not written yet.</div>}
          {data.script?.removed?.length ? <><h3 className="sub">Removed by fact-check</h3><ul>{data.script.removed.map((r, i) => <li key={i}>{r.beatId}: {r.reason}</li>)}</ul></> : null}
          <h3 className="sub">QA</h3>
          {data.qaResults.map((q, i) => <div key={i} className="card"><b>Attempt {q.attempt + 1}: {q.passed ? "passed" : "failed"}</b>{Object.keys(q.scores ?? {}).length > 0 && <div className="muted">{Object.entries(q.scores).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>}<ul>{q.reasons.map((r, j) => <li key={j}>[{r.kind}] {r.reason}</li>)}</ul></div>)}
          <h3 className="sub">Timeline</h3>
          <table><tbody>{data.events.filter((e) => e.to_status).map((e, i) => <tr key={i}><td>{e.stage}</td><td>{e.from_status ?? "∅"} → {e.to_status}</td><td>{ago(e.at)}</td></tr>)}</tbody></table>
          <h3 className="sub">Publications</h3>
          {data.publications.map((p) => <div key={p.id}>{p.platform}: <span className={`pill ${tone(p.status)}`}>{p.status}</span> {p.url && !p.dry_run ? <a href={p.url} target="_blank" rel="noreferrer">view</a> : p.dry_run ? <span className="muted">dry run</span> : null}</div>)}
        </>
      )}
    </aside>
  );
}

export function HeldView(): ReactNode {
  const { data, error } = useData<Held[]>("/api/held");
  if (!data) return <Loading error={error} />;
  if (data.length === 0) return <div className="card">Nothing is held. Everything that reached QA either passed or is still being regenerated.</div>;
  return <>{data.map((h) => (
    <div className="card" key={h.id} style={{ marginBottom: 12 }}>
      <b>{h.topic}</b> <span className="muted">{h.template} · {h.pillar} · {h.attempts} attempts · held {ago(h.heldAt)}</span>
      <p className="muted">These never publish automatically. To retry, run <code>npm run release -- {h.id}</code>.</p>
      <ul>{h.failures.map((f, i) => <li key={i}>[{f.kind}] {f.reason}</li>)}</ul>
      {h.reviewerFeedback.length > 0 && <><b>Reviewer feedback</b><ul>{h.reviewerFeedback.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
    </div>
  ))}</>;
}

export function PublishedView(): ReactNode {
  const { data, error } = useData<Publication[]>("/api/publications?limit=100");
  if (!data) return <Loading error={error} />;
  return (
    <div className="card"><table><thead><tr><th>Topic</th><th>Platform</th><th>Status</th><th>When</th><th>Link</th></tr></thead><tbody>
      {data.map((p) => <tr key={p.id}><td>{p.topic}</td><td>{p.platform}</td><td><span className={`pill ${tone(p.status)}`}>{p.status}</span>{p.dry_run && <span className="pill"> dry run</span>}</td><td>{p.published_at ? when(p.published_at) : `scheduled ${when(p.scheduled_at)}`}</td><td>{p.url && !p.dry_run ? <a href={p.url} target="_blank" rel="noreferrer">open</a> : p.error ? <span className="muted">{p.error.slice(0, 60)}</span> : "–"}</td></tr>)}
    </tbody></table>{data.length === 0 && <div className="muted">No posts yet.</div>}</div>
  );
}

export function AnalyticsView(): ReactNode {
  const { data, error } = useData<Analytics>("/api/analytics?days=30");
  if (!data) return <Loading error={error} />;
  const days = [...new Set(data.series.map((s) => s.day))];
  const sum = (day: string, k: "views" | "posts") => data.series.filter((s) => s.day === day).reduce((a, s) => a + s[k], 0);
  return (
    <>
      {data.synthetic && <div className="verdict warn"><b>Synthetic data.</b> This is a dry run: the numbers below are deterministic fakes used to exercise the pipeline, not real audience data.</div>}
      <div className="grid">
        <div className="card"><h3>Views per day</h3><BarChart data={days.map((d) => ({ label: d, value: sum(d, "views") }))} /></div>
        <div className="card"><h3>Posts per day</h3><BarChart data={days.map((d) => ({ label: d, value: sum(d, "posts") }))} color="var(--ok)" /></div>
      </div>
      <h3 className="sub">Top posts</h3>
      <div className="card"><table><thead><tr><th>Topic</th><th>Platform</th><th>Views</th><th>Likes</th><th>Shares</th><th>Retention</th></tr></thead><tbody>
        {data.top.map((t, i) => <tr key={i}><td>{t.topic}</td><td>{t.platform}</td><td>{t.views?.toLocaleString() ?? "–"}</td><td>{t.likes ?? "–"}</td><td>{t.shares ?? "–"}</td><td>{t.retention_pct != null ? `${Math.round(t.retention_pct)}%` : "–"}</td></tr>)}
      </tbody></table>{data.top.length === 0 && <div className="muted">No measured posts yet.</div>}</div>
    </>
  );
}

export function SpendView(): ReactNode {
  const { data, error } = useData<Spend>("/api/spend");
  if (!data) return <Loading error={error} />;
  const days = [...new Set(data.daily.map((d) => d.day))];
  return (
    <>
      <div className="grid">
        {data.summary.map((s) => (
          <div className="card" key={s.provider}>
            <h3>{s.provider}</h3>
            <div>Today ${s.dailySpent.toFixed(2)} <span className="muted">of ${s.dailyCap.toFixed(2)}</span></div><Meter value={s.dailySpent} cap={s.dailyCap} label="daily" />
            <div style={{ marginTop: 8 }}>Month ${s.monthlySpent.toFixed(2)} <span className="muted">of ${s.monthlyCap.toFixed(2)}</span></div><Meter value={s.monthlySpent} cap={s.monthlyCap} label="monthly" />
            {s.capped && <p><span className="pill bad">cap reached — queues paused</span></p>}
          </div>
        ))}
      </div>
      <h3 className="sub">Daily spend (all providers, last 30 days)</h3>
      <div className="card"><BarChart data={days.map((d) => ({ label: d, value: data.daily.filter((x) => x.day === d).reduce((a, x) => a + x.usd, 0) }))} color="var(--warn)" /></div>
      <p className="muted">Costs are estimates from config/pricing.json used for cap accounting; check provider invoices for actuals.</p>
    </>
  );
}

export function LearningView(): ReactNode {
  const { data, error } = useData<WeightVersion[]>("/api/weights");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <p className="muted">The weekly job adjusts what to make and when to post. Every version is kept; roll back with <code>npm run rollback -- &lt;version&gt;</code>.</p>
      {data.length === 0 ? <div className="card">No weights saved yet (defaults apply).</div> : (
        <div className="card"><table><thead><tr><th>Version</th><th>Kind</th><th>When</th><th>Why</th></tr></thead><tbody>
          {data.map((v) => <tr key={v.version}><td>v{v.version}</td><td>{v.kind}</td><td>{when(v.createdAt)}</td><td>{v.reason}</td></tr>)}
        </tbody></table></div>
      )}
      {data[0] && <><h3 className="sub">Current template weights</h3><div className="card"><table><tbody>{Object.entries(data[0].weights.templates ?? {}).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.toFixed(2)}×</td></tr>)}</tbody></table></div></>}
    </>
  );
}

export function AlertsView(): ReactNode {
  const alerts = useData<AlertRow[]>("/api/alerts?limit=100");
  const dlq = useData<DlqRow[]>("/api/dlq");
  return (
    <>
      <h3 className="sub">Recent alerts</h3>
      <div className="card"><table><thead><tr><th>When</th><th>Level</th><th>Alert</th><th>Sent to</th></tr></thead><tbody>
        {(alerts.data ?? []).map((a, i) => <tr key={i}><td>{ago(a.at)}</td><td><span className={`pill ${a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : ""}`}>{a.severity}</span></td><td>{a.title}{a.body && <div className="muted">{a.body.slice(0, 200)}</div>}</td><td>{a.channels.join(", ") || "log only"}</td></tr>)}
      </tbody></table>{alerts.data?.length === 0 && <div className="muted">No alerts.</div>}</div>
      <h3 className="sub">Dead-lettered jobs</h3>
      <div className="card"><table><thead><tr><th>When</th><th>Queue</th><th>Attempts</th><th>Error</th></tr></thead><tbody>
        {(dlq.data ?? []).map((d, i) => <tr key={i}><td>{ago(d.at)}</td><td>{d.queue}</td><td>{d.attempts}</td><td>{d.error.slice(0, 160)}</td></tr>)}
      </tbody></table>{dlq.data?.length === 0 && <div className="muted">None.</div>}</div>
    </>
  );
}
