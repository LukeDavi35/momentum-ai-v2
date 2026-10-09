export interface WordTiming {
  w: string;
  s: number;
  e: number;
}

export interface Synthesis {
  audioPath: string;
  /** Present only if the provider returned timing. Otherwise the caller estimates from the probed duration. */
  words?: WordTiming[];
}

export interface TtsProvider {
  readonly name: "elevenlabs" | "openai" | "dev-espeak" | (string & {});
  /** Which spend ledger bucket pays for it. null = free (dev). */
  readonly spendProvider: "elevenlabs" | "openai" | null;
  synthesize(text: string, outBase: string): Promise<Synthesis>;
}
