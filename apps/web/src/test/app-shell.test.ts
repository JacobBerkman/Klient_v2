import { describe, expect, it } from "vitest";

import { phaseADeliveryPlan } from "../app-shell";

describe("phase A delivery plan", () => {
  it("prioritizes internal advisor workflows", () => {
    expect(phaseADeliveryPlan.modules.map((module) => module.key)).toEqual([
      "auth",
      "crm",
      "pipeline",
      "households"
    ]);
  });
});
