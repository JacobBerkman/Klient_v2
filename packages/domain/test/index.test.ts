import { describe, expect, it } from "vitest";

import { can, formatSourceAttribution, initialStageOrderIndex } from "../src/index";

describe("domain policies", () => {
  it("allows advisors to write profiles but not administer firms", () => {
    expect(can("advisor", "profiles:write")).toBe(true);
    expect(can("advisor", "firms:admin")).toBe(false);
  });

  it("formats source attribution using the expected display pattern", () => {
    expect(
      formatSourceAttribution({
        cityOrLocation: "Denver",
        venue: "Client Dinner",
        occurredOn: "2026-03-23"
      }).displayValue
    ).toBe("Denver X Client Dinner X 2026-03-23");
  });

  it("assigns incremental stage ordering indexes", () => {
    expect(initialStageOrderIndex(0)).toBe(1);
    expect(initialStageOrderIndex(3)).toBe(4);
  });
});
