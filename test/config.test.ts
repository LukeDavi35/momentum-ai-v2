import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";

describe("config", () => {
  it("loads the real config/*.json files, including the new facebook platform, football pillar, and milestone_moment template", () => {
    const cfg = testConfig();
    expect(cfg.schedule.platforms.facebook).toBeDefined();
    expect(cfg.pillars.pillars.football).toBeDefined();
    expect(cfg.pillars.templates.milestone_moment).toBeDefined();
    expect(cfg.pillars.templates.milestone_moment.pillars).toContain("football");
  });

  it("loads the x platform, basketball pillar, matchup_preview template, and the comments config block, every platform's replies flag defaulting to off", () => {
    const cfg = testConfig();
    expect(cfg.schedule.platforms.x).toBeDefined();
    expect(cfg.pillars.pillars.basketball).toBeDefined();
    expect(cfg.pillars.templates.matchup_preview).toBeDefined();
    expect(cfg.pillars.templates.matchup_preview.pillars).toContain("basketball");
    expect(cfg.schedule.comments.dailyCap).toBeGreaterThan(0);
    for (const p of Object.values(cfg.schedule.platforms)) expect(p.replies).toBe(false);
  });

  it("captions.languages defaults to empty (translations off until the owner lists a language)", () => {
    expect(testConfig().schedule.captions.languages).toEqual([]);
  });
});
