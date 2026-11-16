import type { Pillar } from "../config/index.js";

interface Sport {
  /** Matches the story text (headline + summary). First match wins, so order matters. */
  re: RegExp;
  /** What to type into a stock/archive search. */
  query: string;
  /** Other searches to try if `query` finds nothing. */
  alternates: string[];
  /** Words a clip's title must contain (any) to count as being about this sport. */
  titleWords: string[];
}

const CLUBS = "arsenal|aston villa|bournemouth|brentford|brighton|burnley|chelsea|crystal palace|everton|fulham|leeds|liverpool|man(?:chester)? (?:united|city|utd)|newcastle|nottingham forest|sunderland|tottenham|spurs|west ham|wolves|celtic|rangers|real madrid|barcelona|juventus|bayern";

/** Ordered: the first matching sport wins. */
const SPORTS: Sport[] = [
  { re: /\b(marathon|half[- ]marathon|parkrun|10k|5k)\b/i, query: "marathon runners", alternates: ["road race running", "running race"], titleWords: ["marathon", "running", "runner", "road race"] },
  { re: /\b(sprint|sprinter|100m|200m|400m|hurdles?|relay|diamond league|athletics|track and field|javelin|pole vault|high jump|long jump)\b/i, query: "sprinter track", alternates: ["athletics", "running race"], titleWords: ["athletics", "sprint", "track", "running", "relay", "hurdles", "athlete"] },
  { re: new RegExp(`\\b(football|soccer|premier league|champions league|europa league|striker|goalkeeper|la liga|serie a|bundesliga|fa cup|league cup|carabao|efl|championship|relegation|transfer window|${CLUBS})\\b`, "i"), query: "soccer match", alternates: ["football match", "football fans"], titleWords: ["soccer", "football", "fifa", "premier league", "uefa"] },
  { re: /\b(nfl|quarterback|touchdown|super bowl|american football|college football|buccaneers|cowboys|patriots|chiefs|eagles|packers|49ers|steelers)\b/i, query: "american football", alternates: ["college football"], titleWords: ["nfl", "american football", "college football", "gridiron", "quarterback", "touchdown"] },
  { re: /\b(tennis|wimbledon|grand slam|atp|wta|us open|roland garros|davis cup)\b/i, query: "tennis match", alternates: ["tennis"], titleWords: ["tennis", "wimbledon", "atp", "wta"] },
  { re: /\b(basketball|nba|wnba|dunk)\b/i, query: "basketball game", alternates: ["basketball"], titleWords: ["basketball", "nba", "wnba"] },
  { re: /\b(rugby|six nations|lions tour)\b/i, query: "rugby match", alternates: ["rugby"], titleWords: ["rugby"] },
  { re: /\b(cricket|test match|ashes|wicket|ipl)\b/i, query: "cricket match", alternates: ["cricket"], titleWords: ["cricket"] },
  { re: /\b(golf|masters|pga|ryder cup|birdie)\b/i, query: "golf swing", alternates: ["golf"], titleWords: ["golf"] },
  { re: /\b(formula (1|one)|f1|grand prix|motogp|nascar)\b/i, query: "racing car", alternates: ["motor racing"], titleWords: ["racing", "grand prix", "formula", "motorsport", "race car"] },
  { re: /\b(cycling|tour de france|peloton|velodrome|giro)\b/i, query: "cycling race", alternates: ["cycling"], titleWords: ["cycling", "cyclist", "bicycle", "peloton"] },
  { re: /\b(swim|swimming|swimmer|freestyle|backstroke)\b/i, query: "swimming pool race", alternates: ["swimming"], titleWords: ["swim"] },
  { re: /\b(boxing|boxer|heavyweight|ufc|mma|fight night)\b/i, query: "boxing", alternates: ["boxing match"], titleWords: ["boxing", "boxer", "mma", "ufc"] },
  { re: /\b(baseball|mlb|home run|world series)\b/i, query: "baseball game", alternates: ["baseball"], titleWords: ["baseball", "mlb"] },
  { re: /\b(hockey|nhl|stanley cup|bruins|canadiens|capitals|devils)\b/i, query: "ice hockey", alternates: ["hockey"], titleWords: ["hockey", "nhl"] },
  { re: /\b(gym|workout|weightlifting|strength training|fitness)\b/i, query: "gym workout", alternates: ["weightlifting"], titleWords: ["gym", "workout", "weightlifting", "fitness", "exercise"] },
  { re: /\b(skiing|snowboard|winter olympics|slalom)\b/i, query: "skiing", alternates: ["ski racing"], titleWords: ["ski", "snowboard"] },
];

const PILLAR_FALLBACK: Record<Pillar, string> = {
  running: "running",
  fitness: "gym workout",
  track_and_field: "sprinter track",
  sports_news: "stadium crowd",
};

/**
 * Search words for illustrative footage of a story. Deliberately about the SPORT, never the people or teams: stock and
 * archive libraries don't hold footage of the actual event, and searching a named athlete would only return
 * look-alikes — which would mislead. The video says so (see `ILLUSTRATIVE_NOTE`). `context` (e.g. the article summary)
 * helps when the headline names a club or a person but not the sport ("Crystal Palace sack their manager").
 */
export function footageQuery(headline: string, pillar: Pillar, context = ""): string {
  for (const text of [headline, `${headline} ${context}`]) for (const s of SPORTS) if (s.re.test(text)) return s.query;
  return PILLAR_FALLBACK[pillar];
}

/** Other searches worth trying when the first finds no usable clip. */
export function alternateQueries(query: string): string[] {
  return SPORTS.find((s) => s.query === query)?.alternates ?? [];
}

/** Words that a clip's title must contain at least one of to be about `query`'s sport; the query's own words for a generic search. */
export function titleWordsFor(query: string): string[] {
  const sport = SPORTS.find((s) => s.query === query || s.alternates.includes(query));
  return sport ? sport.titleWords : query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
}

export const ILLUSTRATIVE_NOTE = "Footage is illustrative b-roll, not from the events described.";
