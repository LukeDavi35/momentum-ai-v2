import type { Pillar } from "../config/index.js";

/** Ordered: the first matching sport wins. `query` is what to type into a stock/archive search. */
const SPORTS: Array<{ re: RegExp; query: string }> = [
  { re: /\b(marathon|half[- ]marathon|parkrun|10k|5k)\b/i, query: "marathon runners" },
  { re: /\b(sprint|sprinter|100m|200m|400m|hurdles?|relay|diamond league|athletics|track and field)\b/i, query: "sprinter track" },
  { re: /\b(football|soccer|premier league|champions league|striker|goalkeeper|la liga|serie a|bundesliga)\b/i, query: "soccer match" },
  { re: /\b(nfl|quarterback|touchdown|super bowl|american football|buccaneers|cowboys|patriots|chiefs)\b/i, query: "american football" },
  { re: /\b(tennis|wimbledon|grand slam|atp|wta|us open|roland garros)\b/i, query: "tennis match" },
  { re: /\b(basketball|nba|wnba|dunk)\b/i, query: "basketball game" },
  { re: /\b(rugby|six nations|lions tour)\b/i, query: "rugby match" },
  { re: /\b(cricket|test match|ashes|wicket|ipl)\b/i, query: "cricket match" },
  { re: /\b(golf|masters|pga|ryder cup|birdie)\b/i, query: "golf swing" },
  { re: /\b(formula (1|one)|f1|grand prix|motogp|nascar)\b/i, query: "racing car" },
  { re: /\b(cycling|tour de france|peloton|velodrome|giro)\b/i, query: "cycling race" },
  { re: /\b(swim|swimming|swimmer|pool|freestyle|backstroke)\b/i, query: "swimming pool race" },
  { re: /\b(boxing|boxer|heavyweight|ufc|mma|fight night)\b/i, query: "boxing" },
  { re: /\b(baseball|mlb|home run|world series)\b/i, query: "baseball game" },
  { re: /\b(hockey|nhl|stanley cup)\b/i, query: "ice hockey" },
  { re: /\b(gym|workout|weightlifting|strength training|fitness)\b/i, query: "gym workout" },
  { re: /\b(skiing|snowboard|winter olympics|slalom)\b/i, query: "skiing" },
];

const PILLAR_FALLBACK: Record<Pillar, string> = {
  running: "running",
  fitness: "gym workout",
  track_and_field: "sprinter track",
  sports_news: "stadium crowd",
};

/**
 * Search words for illustrative footage of a story. Deliberately about the SPORT, never the people or teams: stock and
 * archive libraries don't hold footage of the actual event, and searching for a named athlete would only return
 * look-alikes — which would mislead. The video says so (see `ILLUSTRATIVE_NOTE`).
 */
export function footageQuery(headline: string, pillar: Pillar): string {
  for (const s of SPORTS) if (s.re.test(headline)) return s.query;
  return PILLAR_FALLBACK[pillar];
}

export const ILLUSTRATIVE_NOTE = "Footage is illustrative b-roll, not from the events described.";
