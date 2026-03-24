import { describe, expect, it } from "vitest";

import { buildApp } from "../app";

describe("api phase A", () => {
  it("registers a firm admin and allows prospect creation plus stage movement", async () => {
    const app = await buildApp();

    const registerResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        firmName: "North Ridge Wealth",
        firstName: "Avery",
        lastName: "Stone",
        email: "avery@northridge.test",
        password: "SecurePass123!"
      }
    });

    expect(registerResponse.statusCode).toBe(201);
    const session = registerResponse.json();
    const token = session.token as string;

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "prospect",
        firstName: "Jordan",
        lastName: "Client",
        email: "jordan@example.com",
        stage: "discovery",
        source: {
          cityOrLocation: "Dallas",
          venue: "Lunch Seminar",
          occurredOn: "2026-03-23"
        }
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as { id: string; stageOrderIndex: number; source: { displayValue: string } };
    expect(created.stageOrderIndex).toBe(1);
    expect(created.source.displayValue).toBe("Dallas X Lunch Seminar X 2026-03-23");

    const moveResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/profiles/${created.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stage: "analysis"
      }
    });

    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json().data.stage).toBe("analysis");

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/v1/audit-events",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().data.length).toBeGreaterThanOrEqual(2);
  });
});
