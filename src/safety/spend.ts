import type { Db } from "../db/db.js";
import type { LimitsConfig, PricingConfig, SpendProvider } from "../config/index.js";
import { PROVIDER_QUEUES, type QueueName } from "../queue/names.js";

export class SpendCapExceeded extends Error {
  readonly queues: QueueName[];
  constructor(
    public readonly provider: SpendProvider,
    public readonly window: "daily" | "monthly",
    public readonly spent: number,
    public readonly cap: number,
  ) {
    super(`Spend cap exceeded for ${provider} (${window}: $${spent.toFixed(4)} of $${cap.toFixed(2)})`);
    this.name = "SpendCapExceeded";
    this.queues = PROVIDER_QUEUES[provider];
  }
}

export interface SpendSummaryRow {
  provider: SpendProvider;
  dailySpent: number;
  dailyCap: number;
  monthlySpent: number;
  monthlyCap: number;
  capped: boolean;
}

export interface SpendRecord {
  provider: SpendProvider;
  category: string;
  usd: number;
  units?: number;
  contentId?: string | null;
  correlationId?: string | null;
}

/** UTC day / month boundaries — simple, tz-independent, and what provider billing mostly uses. */
export const startOfUtcDay = (now = new Date()): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const startOfUtcMonth = (now = new Date()): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export class SpendTracker {
  constructor(
    private readonly db: Db,
    private readonly limits: LimitsConfig,
    private readonly pricing: PricingConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // --- cost estimators (conservative; see config/pricing.json) --------------
  llmCost(model: string, inputTokens: number, outputTokens: number): number {
    const p = this.pricing.llm[model] ?? this.pricing.llm["default"] ?? { inPerM: 15, outPerM: 75 };
    return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
  }
  ttsCost(provider: "elevenlabs" | "openai", chars: number): number {
    return (chars / 1000) * (provider === "elevenlabs" ? this.pricing.elevenlabsPerKChars : this.pricing.openaiTtsPerKChars);
  }
  embeddingCost(tokens: number): number {
    return (tokens / 1_000_000) * this.pricing.openaiEmbeddingPerMTokens;
  }
  renderCost(videoSeconds: number): number {
    return (videoSeconds / 60) * this.pricing.renderPerMinute;
  }

  private async spentSince(provider: SpendProvider, since: Date): Promise<number> {
    const res = await this.db.query<{ s: number | null }>(`SELECT COALESCE(SUM(usd), 0) AS s FROM spend_ledger WHERE provider = $1 AND at >= $2`, [
      provider,
      since.toISOString(),
    ]);
    return Number(res.rows[0]?.s ?? 0);
  }

  /** Throws SpendCapExceeded if spending `projectedUsd` more would breach the daily or monthly cap. */
  async guard(provider: SpendProvider, projectedUsd = 0): Promise<void> {
    const cap = this.limits.providers[provider];
    if (!cap) throw new Error(`No spend limit configured for provider ${provider}`);
    const now = this.now();
    const [day, month] = await Promise.all([this.spentSince(provider, startOfUtcDay(now)), this.spentSince(provider, startOfUtcMonth(now))]);
    if (day + projectedUsd > cap.daily) throw new SpendCapExceeded(provider, "daily", day, cap.daily);
    if (month + projectedUsd > cap.monthly) throw new SpendCapExceeded(provider, "monthly", month, cap.monthly);
  }

  async isCapped(provider: SpendProvider): Promise<boolean> {
    try {
      await this.guard(provider, 0);
      return false;
    } catch (e) {
      if (e instanceof SpendCapExceeded) return true;
      throw e;
    }
  }

  async record(r: SpendRecord): Promise<void> {
    await this.db.query(`INSERT INTO spend_ledger (provider, category, units, usd, content_id, correlation_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      r.provider,
      r.category,
      r.units ?? 0,
      r.usd,
      r.contentId ?? null,
      r.correlationId ?? null,
      this.now().toISOString(),
    ]);
  }

  async summary(): Promise<SpendSummaryRow[]> {
    const now = this.now();
    const out: SpendSummaryRow[] = [];
    for (const [provider, cap] of Object.entries(this.limits.providers) as [SpendProvider, { daily: number; monthly: number }][]) {
      const [d, m] = await Promise.all([this.spentSince(provider, startOfUtcDay(now)), this.spentSince(provider, startOfUtcMonth(now))]);
      out.push({ provider, dailySpent: d, dailyCap: cap.daily, monthlySpent: m, monthlyCap: cap.monthly, capped: d >= cap.daily || m >= cap.monthly });
    }
    return out;
  }
}
