import { scan, type PolicyViolation } from "../qa/policy.js";

/** Cheap, deterministic shortcuts tried before any LLM call - cheaper and safer than asking a model every time. */
const CRISIS_RE = /\b(kill myself|suicide|self[- ]harm|want to die|end it all|hurt myself)\b/i;
const SPAM_RE = /\b(follow (me|for follow)|f4f|check out my|buy followers|free (followers|likes|crypto|gift card)|click (here|this link)|dm for (promo|collab))\b/i;
const EMOJI_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s‍️]+$/u;

export const isCrisisLanguage = (text: string): boolean => CRISIS_RE.test(text);
export const isLikelySpam = (text: string): boolean => SPAM_RE.test(text);
export const isEmojiOnly = (text: string): boolean => {
  const t = text.trim();
  return t.length > 0 && EMOJI_ONLY_RE.test(t);
};

const LINK_RE = /\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(com|net|org|co|io|tv)\b/i;
const PRICE_RE = /[£$€]\s?\d|\b\d+\s?(usd|gbp|eur|quid|bucks)\b/i;
const CONTACT_RE = /\b(dm me|dm us|message me|email me|whatsapp|telegram|contact (me|us)|my (email|number))\b/i;
const MENTION_RE = /@\w+/;
const AI_DENIAL_RE = /\b(i'?m not (an? )?ai|i am not (an? )?ai|i'?m real|i'?m human)\b/i;

export const MAX_REPLY_CHARS = 280; // the tightest limit among the platforms that support replies (currently none need more)

export interface ReplyCheckResult {
  ok: boolean;
  issues: string[];
}

/**
 * Deterministic gate a drafted reply must pass before it is ever sent - same reasoning as the
 * video QA policy gate (src/qa/policy.ts): cheap, blunt, fails closed. Reuses TEXT_RULES via
 * scan() for the generic hate/abuse/medical-advice/doping rules, plus reply-only checks.
 */
export function checkReply(text: string, respondingToAiQuestion: boolean): ReplyCheckResult {
  const issues: string[] = [];
  const t = text.trim();
  if (!t) issues.push("empty reply");
  if (t.length > MAX_REPLY_CHARS) issues.push(`reply too long (${t.length} > ${MAX_REPLY_CHARS})`);
  if (LINK_RE.test(t)) issues.push("contains a link");
  if (PRICE_RE.test(t)) issues.push("mentions a price");
  if (CONTACT_RE.test(t)) issues.push("invites off-platform contact");
  if (MENTION_RE.test(t)) issues.push("mentions another account");
  if (AI_DENIAL_RE.test(t)) issues.push("denies being AI");
  if (respondingToAiQuestion && !/\bai\b/i.test(t)) issues.push('an "are you AI" question must be answered honestly, not dodged');
  const violations: PolicyViolation[] = [];
  scan(t, "reply", violations);
  issues.push(...violations.map((v) => v.excerpt));
  return { ok: issues.length === 0, issues };
}
