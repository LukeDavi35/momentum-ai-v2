export type LlmRole = "writer" | "reviewer" | "fast";

export interface CompleteRequest {
  /** Stable label of the call site, e.g. "script.write". Real providers ignore it; the stub dispatches on it. */
  task: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  /** Structured copy of what the prompt was built from. Only the stub reads this. */
  input?: unknown;
}

export interface CompleteResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  /** false for the stub: its calls cost nothing and are not written to the spend ledger. */
  readonly billable: boolean;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}
