import { randomUUID } from "node:crypto";

import type { AuthenticatedUser, Household, HouseholdMember, HouseholdRole } from "@klient/domain";
import { z } from "zod";

export const createHouseholdSchema = z.object({
  name: z.string().min(1),
  primaryClientId: z.string().min(1)
});

export const addHouseholdMemberSchema = z.object({
  clientId: z.string().min(1),
  role: z.enum(["primary", "spouse", "dependent", "other"] satisfies [HouseholdRole, ...HouseholdRole[]])
});

export type CreateHouseholdInput = z.infer<typeof createHouseholdSchema>;
export type AddHouseholdMemberInput = z.infer<typeof addHouseholdMemberSchema>;

export class HouseholdService {
  private readonly households = new Map<string, Household>();
  private readonly members: HouseholdMember[] = [];

  createHousehold(user: AuthenticatedUser, input: CreateHouseholdInput): Household {
    const household: Household = {
      id: randomUUID(),
      firmId: user.firmId,
      name: input.name,
      primaryClientId: input.primaryClientId,
      createdAt: new Date().toISOString()
    };

    this.households.set(household.id, household);
    this.members.push({
      householdId: household.id,
      clientId: input.primaryClientId,
      role: "primary",
      firmId: user.firmId,
      createdAt: household.createdAt
    });

    return household;
  }

  addMember(user: AuthenticatedUser, householdId: string, input: AddHouseholdMemberInput): HouseholdMember {
    const household = this.households.get(householdId);
    if (!household || household.firmId !== user.firmId) {
      throw new Error("Household not found.");
    }

    const member: HouseholdMember = {
      householdId,
      clientId: input.clientId,
      role: input.role,
      firmId: user.firmId,
      createdAt: new Date().toISOString()
    };
    this.members.push(member);
    return member;
  }

  listMembers(user: AuthenticatedUser, householdId: string): HouseholdMember[] {
    return this.members.filter((member) => member.firmId === user.firmId && member.householdId === householdId);
  }
}
