import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import type { ScriptDoc } from "./types.js";

const translationSchema = z.object({
  translations: z.record(z.string().min(1), z.object({ instagram: z.string().max(1500), youtube: z.string().max(2500) })),
});

/** One call translates both long-form captions into every configured language at once - cheaper than one call per language. */
export async function translateCaptions(llm: LlmClient, doc: ScriptDoc, languages: string[]): Promise<Record<string, { instagram: string; youtube: string }>> {
  if (languages.length === 0) return {};
  const system = "You translate short social captions for a sports-highlights video account, keeping the same tone and facts. Translate faithfully: add nothing, invent nothing, no hashtags, no emoji beyond the original's.";
  const prompt = `Instagram caption: ${JSON.stringify(doc.variants.instagram.caption)}\nYouTube description: ${JSON.stringify(doc.variants.youtube.description)}\n\nTranslate BOTH into these languages (ISO codes): ${languages.join(", ")}.\nReturn JSON {"translations": {"<code>": {"instagram": "...", "youtube": "..."}}}`;
  const out = await llm.json({
    task: "script.translate",
    role: "fast",
    system,
    prompt,
    schema: translationSchema,
    maxTokens: 400 * languages.length,
    input: { instagram: doc.variants.instagram.caption, youtube: doc.variants.youtube.description, languages },
  });
  return out.translations;
}
