import nodemailer from "nodemailer";
import type { Db } from "../db/db.js";
import type { Env } from "../config/index.js";
import type { Logger } from "../logger.js";

export type Severity = "info" | "warning" | "critical";

export interface AlertInput {
  /** Stable identifier used for throttling, e.g. "spend_cap:anthropic". */
  key: string;
  severity: Severity;
  title: string;
  body?: string;
  /** Suppress repeats of the same key within this window. 0 = never suppress. Default 30 min. */
  throttleMs?: number;
}

export interface AlertResult {
  sent: boolean;
  suppressed: boolean;
  channels: string[];
}

type FetchLike = typeof fetch;
type Mailer = { sendMail(opts: { from: string; to: string; subject: string; text: string }): Promise<unknown> };

const DEFAULT_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Fans an alert out to every configured channel. Never throws: alerting must not be able to
 * take down the thing it is reporting on. Every alert (sent or suppressed) is persisted so
 * the dashboard can show history.
 */
export class Alerter {
  private mailer?: Mailer;

  constructor(
    private readonly db: Db,
    private readonly env: Pick<
      Env,
      | "DISCORD_WEBHOOK_URL"
      | "TELEGRAM_BOT_TOKEN"
      | "TELEGRAM_CHAT_ID"
      | "GENERIC_WEBHOOK_URL"
      | "SMTP_URL"
      | "ALERT_EMAIL_TO"
      | "ALERT_EMAIL_FROM"
      | "DRY_RUN"
    >,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    mailer?: Mailer,
  ) {
    this.mailer = mailer;
  }

  configuredChannels(): string[] {
    const c: string[] = [];
    if (this.env.DISCORD_WEBHOOK_URL) c.push("discord");
    if (this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID) c.push("telegram");
    if (this.env.GENERIC_WEBHOOK_URL) c.push("webhook");
    if (this.env.SMTP_URL && this.env.ALERT_EMAIL_TO) c.push("email");
    return c;
  }

  async send(a: AlertInput): Promise<AlertResult> {
    const throttle = a.throttleMs ?? DEFAULT_THROTTLE_MS;
    try {
      if (throttle > 0) {
        const recent = await this.db.query(
          `SELECT 1 FROM alerts_log WHERE key = $1 AND suppressed = false AND at > now() - ($2 || ' milliseconds')::interval LIMIT 1`,
          [a.key, String(throttle)],
        );
        if (recent.rowCount > 0) {
          await this.db.query(`INSERT INTO alerts_log (key, severity, title, body, channels, suppressed) VALUES ($1,$2,$3,$4,'[]'::jsonb,true)`, [
            a.key,
            a.severity,
            a.title,
            a.body ?? "",
          ]);
          return { sent: false, suppressed: true, channels: [] };
        }
      }
    } catch (e) {
      this.log.error({ err: (e as Error).message }, "alert throttle lookup failed; sending anyway");
    }

    const logFn = a.severity === "critical" ? this.log.error.bind(this.log) : a.severity === "warning" ? this.log.warn.bind(this.log) : this.log.info.bind(this.log);
    logFn({ alertKey: a.key, severity: a.severity }, `ALERT: ${a.title}${a.body ? ` — ${a.body}` : ""}`);

    const text = `[${a.severity.toUpperCase()}${this.env.DRY_RUN ? " · dry-run" : ""}] ${a.title}${a.body ? `\n${a.body}` : ""}`;
    const delivered: string[] = [];
    const attempts: Array<[string, () => Promise<void>]> = [];

    if (this.env.DISCORD_WEBHOOK_URL) {
      const url = this.env.DISCORD_WEBHOOK_URL;
      attempts.push(["discord", () => this.post(url, { content: text.slice(0, 1900) })]);
    }
    if (this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID) {
      const url = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const chat = this.env.TELEGRAM_CHAT_ID;
      attempts.push(["telegram", () => this.post(url, { chat_id: chat, text: text.slice(0, 4000) })]);
    }
    if (this.env.GENERIC_WEBHOOK_URL) {
      const url = this.env.GENERIC_WEBHOOK_URL;
      attempts.push(["webhook", () => this.post(url, { key: a.key, severity: a.severity, title: a.title, body: a.body ?? "", text })]);
    }
    if (this.env.SMTP_URL && this.env.ALERT_EMAIL_TO) {
      attempts.push([
        "email",
        async () => {
          this.mailer ??= nodemailer.createTransport(this.env.SMTP_URL!);
          await this.mailer.sendMail({
            from: this.env.ALERT_EMAIL_FROM ?? this.env.ALERT_EMAIL_TO!,
            to: this.env.ALERT_EMAIL_TO!,
            subject: `[Momentum ${a.severity}] ${a.title}`,
            text,
          });
        },
      ]);
    }

    await Promise.all(
      attempts.map(async ([name, fn]) => {
        try {
          await fn();
          delivered.push(name);
        } catch (e) {
          this.log.error({ channel: name, err: (e as Error).message }, "alert channel delivery failed");
        }
      }),
    );

    try {
      await this.db.query(`INSERT INTO alerts_log (key, severity, title, body, channels, suppressed) VALUES ($1,$2,$3,$4,$5::jsonb,false)`, [
        a.key,
        a.severity,
        a.title,
        a.body ?? "",
        JSON.stringify(delivered),
      ]);
    } catch (e) {
      this.log.error({ err: (e as Error).message }, "failed to persist alert");
    }
    return { sent: true, suppressed: false, channels: delivered };
  }

  private async post(url: string, body: unknown): Promise<void> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
