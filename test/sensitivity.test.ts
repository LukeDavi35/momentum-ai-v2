import { describe, expect, it } from "vitest";
import { describeHits, findSensitive } from "../src/qa/sensitivity.js";

describe("sensitive-topic detection", () => {
  it.each([
    ["Tributes paid after sprinter dies aged 24", "death"],
    ["Marathon runner dead after collapsing in race", "death"],
    ["Coach faces allegations of abuse", "abuse_crime"],
    ["Star arrested after incident", "abuse_crime"],
    ["Athlete diagnosed with cancer", "serious_harm"],
    ["Player taken to intensive care", "serious_harm"],
    ["Club sued over contract", "legal"],
    ["Sprinter banned for doping after failed drug test", "legal"],
    ["Cyclist in critical condition after crash", "serious_harm"],
  ])("flags %j as %s", (text, category) => {
    expect(findSensitive(text).map((h) => h.category)).toContain(category);
  });

  it.each([
    "Kipyegon breaks 1500m world record in Paris",
    "Three habits for easier running",
    "She won the time trial by four seconds",
    "A dead heat at the line separated the pair",
    "Buccaneers explode in third quarter in win over Cowboys",
    "Warm up properly before a hard session",
    "Champion returns from injury to win the race",
  ])("leaves ordinary text alone: %j", (text) => {
    expect(findSensitive(text)).toEqual([]);
  });

  it("scans several texts together, ignores empties, and describes hits", () => {
    const hits = findSensitive("Nice day", null, undefined, "tributes after he died");
    expect(describeHits(hits)).toBe('death ("died")');
  });
});
