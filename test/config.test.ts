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
});
