/**
 * Brand-safety: an automated, upbeat sports-video brand must not turn a death, serious injury, abuse allegation or
 * legal case into content. These stories are filtered out at ideation, and anything that still reaches QA is HELD
 * for a human (never regenerated: rewriting the same story doesn't make it appropriate).
 * Deliberately blunt and over-inclusive — a false positive costs one skipped story, a false negative is a PR incident.
 */
export interface SensitiveHit {
  category: "death" | "serious_harm" | "abuse_crime" | "legal";
  match: string;
}

const RULES: Array<[SensitiveHit["category"], RegExp]> = [
  ["death", /\b(died|dies|dead(?! heat)|death|deaths|killed|killing of|fatal(ly)?|passed away|funeral|memorial|murder(ed)?|suicide|drown(ed|ing)|cardiac arrest|rip\b|mourn(s|ing)?|tribute to the late|late (father|mother|husband|wife|son|daughter))\b/i],
  ["serious_harm", /\b(tragedy|tragic|horrific|life[- ]threatening|critical condition|intensive care|induced coma|paraly[sz]ed|cancer|tumou?r|diagnosed with|terminal(ly)? ill|collapsed (on|during|in)|stretchered off|rushed to hospital)\b/i],
  ["abuse_crime", /\b(abuse[sd]?|assault(ed)?|rape[sd]?|sexual(ly)?|harass(ed|ment)|grooming|domestic violence|stalk(ed|ing)|arrest(ed)?|police (investigation|probe|inquiry)|allegations?|accused|alleged(ly)?|racis[tm]|racial(ly)? abus)/i],
  ["legal", /\b(lawsuit|sued|sues|charged with|convicted|conviction|sentenced|(?<!time )trial|court case|tribunal|banned for (life|doping)|failed (a )?drug test)\b/i],
];

export function findSensitive(...texts: Array<string | null | undefined>): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  const text = texts.filter(Boolean).join(" \n ");
  for (const [category, re] of RULES) {
    const m = text.match(re);
    if (m) hits.push({ category, match: m[0].toLowerCase() });
  }
  return hits;
}

export const describeHits = (hits: SensitiveHit[]): string => hits.map((h) => `${h.category} ("${h.match}")`).join(", ");
