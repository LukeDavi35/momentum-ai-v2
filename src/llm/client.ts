import type { ZodType } from "zod";
import type { Env } from "../config/index.js";
import type { Logger } from "../logger.js";
import type { SpendTracker } from "../safety/spend.js";
import type { LlmProvider, LlmRole } from "./types.js";

export class LlmOutputError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/** Pulls the first balanced JSON object/array out of a model reply (handles code fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace matching
  }
  const start = candidate.search(/[{[]/);
  if (start < 0) throw new Error("no JSON found in model output");
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error("unbalanced JSON in model output");
}

export interface JsonCall<T> {
  task: string;
  role: LlmRole;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  maxTokens: number;
  temperature?: number;
  input?: unknown;
  contentId?: string | null;
  correlationId?: string | null;
}

export class LlmClient {
  constructor(
    readonly provider: LlmProvider,
    private readonly spend: SpendTracker,
    private readonly models: Pick<Env, "LLM_MODEL_WRITER" | "LLM_MODEL_REVIEWER" | "LLM_MODEL_FAST">,
    private readonly log: Logger,
  ) {}

  get isStub(): boolean {
    return !this.provider.billable;
  }

  modelFor(role: LlmRole): string {
    return role === "writer" ? this.models.LLM_MODEL_WRITER : role === "reviewer" ? this.models.LLM_MODEL_REVIEWER : this.models.LLM_MODEL_FAST;
  }

  /** Spend-guarded, schema-validated JSON completion. One automatic repair retry on invalid output. */
  async json<T>(call: JsonCall<T>): Promise<T> {
    const model = this.modelFor(call.role);
    let prompt = call.prompt;
    let lastRaw = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.provider.billable) {
        const projected = this.spend.llmCost(model, Math.ceil((call.system.length + prompt.length) / 3.5), call.maxTokens);
        await this.spend.guard("anthropic", projected);
      }
      const res = await this.provider.complete({
        task: call.task,
        model,
        system: call.system,
        prompt,
        maxTokens: call.maxTokens,
        temperature: call.temperature,
        input: call.input,
      });
      if (this.provider.billable) {
        await this.spend.record({
          provider: "anthropic",
          category: call.task,
          usd: this.spend.llmCost(model, res.inputTokens, res.outputTokens),
          units: res.inputTokens + res.outputTokens,
          contentId: call.contentId,
          correlationId: call.correlationId,
        });
      }
      lastRaw = res.text;
      try {
        const parsed = call.schema.safeParse(extractJson(res.text));
        if (parsed.success) return parsed.data;
        throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      } catch (e) {
        this.log.warn({ task: call.task, attempt, err: (e as Error).message }, "LLM output failed validation");
        prompt = `${call.prompt}\n\nYour previous reply was invalid (${(e as Error).message}). Reply again with ONLY valid JSON matching the requested shape, no prose.`;
      }
    }
    throw new LlmOutputError(`LLM output for ${call.task} failed validation after retry`, lastRaw);
  }
}
