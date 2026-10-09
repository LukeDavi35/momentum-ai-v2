export const QUEUE_NAMES = ["ingest", "ideate", "script", "voice", "render", "qa", "publish", "analytics"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const DEAD_LETTER_QUEUE = "dead-letter";

/** Which queues must stop when a provider's spend cap is hit. */
export const PROVIDER_QUEUES: Record<"anthropic" | "elevenlabs" | "openai" | "render", QueueName[]> = {
  anthropic: ["ideate", "script", "qa"],
  elevenlabs: ["voice"],
  openai: ["voice"],
  render: ["render"],
};
