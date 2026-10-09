import { writeFileSync } from "node:fs";
import type { AppConfig } from "../config/index.js";
import { run, type Runner } from "../media/exec.js";
import { wordsFromCharAlignment } from "./align.js";
import type { Synthesis, TtsProvider } from "./types.js";

type FetchLike = typeof fetch;

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs" as const;
  readonly spendProvider = "elevenlabs" as const;
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly modelId: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async synthesize(text: string, outBase: string): Promise<Synthesis> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as {
      audio_base64?: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    };
    if (!j.audio_base64) throw new Error("ElevenLabs response had no audio");
    const audioPath = `${outBase}.mp3`;
    writeFileSync(audioPath, Buffer.from(j.audio_base64, "base64"));
    const a = j.alignment;
    return { audioPath, words: a ? wordsFromCharAlignment(a.characters, a.character_start_times_seconds, a.character_end_times_seconds) : undefined };
  }
}

export class OpenAiTts implements TtsProvider {
  readonly name = "openai" as const;
  readonly spendProvider = "openai" as const;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly voice: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async synthesize(text: string, outBase: string): Promise<Synthesis> {
    const res = await this.fetchImpl("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: "mp3" }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const audioPath = `${outBase}.mp3`;
    writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));
    return { audioPath }; // no timing available -> caller estimates from probed duration
  }
}

/** DEV ONLY: robotic offline voice so dry-runs have real audio. Never used when DRY_RUN=false. */
export class EspeakTts implements TtsProvider {
  readonly name = "dev-espeak" as const;
  readonly spendProvider = null;
  constructor(private readonly runner: Runner = run) {}

  async synthesize(text: string, outBase: string): Promise<Synthesis> {
    const audioPath = `${outBase}.wav`;
    await this.runner("espeak-ng", ["-v", "en-gb", "-s", "160", "-p", "45", "-w", audioPath, text]);
    return { audioPath };
  }
}

/** Ordered provider chain: primary first, fallbacks after. The dev voice is only ever offered in dry-run. */
export function buildTtsChain(cfg: AppConfig, fetchImpl: FetchLike = fetch): TtsProvider[] {
  const e = cfg.env;
  const chain: TtsProvider[] = [];
  if (e.ELEVENLABS_API_KEY && e.ELEVENLABS_VOICE_ID) chain.push(new ElevenLabsTts(e.ELEVENLABS_API_KEY, e.ELEVENLABS_VOICE_ID, e.ELEVENLABS_MODEL_ID, fetchImpl));
  if (e.OPENAI_API_KEY) chain.push(new OpenAiTts(e.OPENAI_API_KEY, e.OPENAI_TTS_MODEL, e.OPENAI_TTS_VOICE, fetchImpl));
  if (chain.length === 0 && e.DRY_RUN && e.ALLOW_DEV_TTS) chain.push(new EspeakTts());
  return chain;
}
