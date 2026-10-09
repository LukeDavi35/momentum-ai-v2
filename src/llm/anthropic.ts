import Anthropic from "@anthropic-ai/sdk";
import type { CompleteRequest, CompleteResponse, LlmProvider } from "./types.js";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly billable = true;
  private readonly client: Anthropic;

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}
