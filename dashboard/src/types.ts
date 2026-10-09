export interface Overview {
  dryRun: boolean;
  llm: string;
  killSwitch: { active: boolean; source: "env" | "dashboard" | null; reason?: string; since?: string; by?: string };
  pausedQueues: Record<string, { provider: string; since: string; reason: string }>;
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number; paused: boolean }>;
  contentByStatus: Record<string, number>;
  posts24h: number;
  maxPostsPerDay: number;
  alertChannels: string[];
  connectedAccounts: Array<{ platform: string; account_name: string | null; expires_at: string | null; last_refresh_error: string | null }>;
}
export interface ContentRow {
  id: string;
  correlation_id: string;
  status: string;
  pillar: string;
  template: string;
  topic: string;
  hook_style: string | null;
  score: number | null;
  regen_count: number;
  error: string | null;
  failed_stage: string | null;
  created_at: string;
  status_changed_at: string;
  generator: string | null;
  voice_provider: string | null;
  dev_voice: boolean | null;
}
export interface Held {
  id: string;
  topic: string;
  template: string;
  pillar: string;
  attempts: number;
  reason: string | null;
  failures: Array<{ kind: string; reason: string }>;
  reviewerFeedback: string[];
  scores: Record<string, number> | null;
  heldAt: string;
}
export interface Publication {
  id: string;
  platform: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  url: string | null;
  error: string | null;
  dry_run: boolean;
  warnings: string[] | null;
  topic: string;
  template: string;
  content_id: string;
}
export interface Analytics {
  dryRun: boolean;
  synthetic: boolean;
  series: Array<{ day: string; platform: string; posts: number; views: number; likes: number; shares: number }>;
  top: Array<{ topic: string; template: string; platform: string; url: string | null; views: number | null; likes: number | null; shares: number | null; retention_pct: number | null }>;
}
export interface Spend {
  currency: string;
  summary: Array<{ provider: string; dailySpent: number; dailyCap: number; monthlySpent: number; monthlyCap: number; capped: boolean }>;
  daily: Array<{ day: string; provider: string; usd: number }>;
}
export interface WeightVersion {
  version: number;
  kind: string;
  reason: string;
  createdAt: string;
  weights: Record<string, Record<string, number>>;
}
export interface AlertRow {
  key: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  channels: string[];
  at: string;
}
export interface DlqRow {
  queue: string;
  job_id: string | null;
  content_id: string | null;
  error: string;
  attempts: number;
  at: string;
}
export interface ContentDetail extends ContentRow {
  events: Array<{ from_status: string | null; to_status: string | null; stage: string; detail: Record<string, unknown>; at: string }>;
  qaResults: Array<{ attempt: number; passed: boolean; scores: Record<string, number>; reasons: Array<{ kind: string; reason: string }>; created_at: string }>;
  publications: Array<{ id: string; platform: string; status: string; url: string | null; error: string | null; dry_run: boolean }>;
  script: { beats: Array<{ id: string; text: string }>; removed: Array<{ beatId: string; reason: string }>; generator: string } | null;
  qa_feedback?: string | null;
}
