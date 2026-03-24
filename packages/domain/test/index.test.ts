import { describe, expect, it } from "vitest";

import {
  can,
  canonicalTemplateModelPrinciples,
  formatSourceAttribution,
  initialStageOrderIndex,
  mappingTransformCatalog,
  type TemplateMapping
} from "../src/index";

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

  it("keeps canonical template model principles and supported transforms in sync", () => {
    expect(canonicalTemplateModelPrinciples.some((entry) => entry.includes("direct, composite, split, and repeater"))).toBe(true);
    expect(mappingTransformCatalog).toEqual(expect.arrayContaining(["date", "phone", "currency", "checkbox"]));
  });

  it("supports all mapping editor mapping kinds in the canonical model", () => {
    const mappings: TemplateMapping[] = [
      { id: "m1", kind: "direct", pdfFieldName: "phone", sourcePath: "profile.phone", transform: { type: "phone" } },
      { id: "m2", kind: "composite", pdfFieldName: "full_name", sourcePaths: ["profile.firstName", "profile.lastName"], joinWith: " " },
      {
        id: "m3",
        kind: "split",
        sourcePath: "profile.fullName",
        delimiter: " ",
        targets: [
          { pdfFieldName: "first_name", index: 0 },
          { pdfFieldName: "last_name", index: 1 }
        ]
      },
      {
        id: "m4",
        kind: "repeater",
        repeaterGroupId: "assets",
        sourceCollectionPath: "profile.assets",
        itemMappings: [{ pdfFieldName: "asset_name", sourcePath: "name" }]
      }
    ];

    expect(mappings.map((entry) => entry.kind)).toEqual(["direct", "composite", "split", "repeater"]);
  });
});
