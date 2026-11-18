// Collab tickets (docs/spec/collab.md, section 3; ADR 0005): what a provider shows /collab to open
// a score. A ticket is fetched again for every connection, lasts 60 seconds and opens once.
import { role } from "@studio/contracts";
import type { Redis } from "ioredis";
import { z } from "zod";

import { readJson } from "./storedJson";
import { isToken, newToken } from "./tokens";

export const TICKET_TTL_SECONDS = 60;

/** A member: their account, the session the ticket was given to, and their role. */
const member = z.object({ kind: z.literal("member"), accountId: z.string(), sessionId: z.string(), role });
export type Member = z.infer<typeof member>;

/** A guest: the read-only link it came with, and nothing else. */
const guest = z.object({ kind: z.literal("guest"), linkToken: z.string() });
export type Guest = z.infer<typeof guest>;

/**
 * Who the ticket lets in, to which score: a member, with the role they had when it was given, or a
 * guest. What Redis holds is read by these fields: a value that is not a ticket counts as none.
 */
const ticketSchema = z.discriminatedUnion("kind", [member.extend({ scoreId: z.string() }), guest.extend({ scoreId: z.string() })]);
export type Ticket = z.infer<typeof ticketSchema>;

const ticketKey = (ticket: string) => `collab-ticket:${ticket}`;

export class CollabTickets {
  constructor(private readonly redis: Redis) {}

  async issue(ticket: Ticket): Promise<string> {
    const value = newToken();
    await this.redis.set(ticketKey(value), JSON.stringify(ticket), "EX", TICKET_TTL_SECONDS);
    return value;
  }

  /**
   * What the ticket was given for, once: the ticket is gone afterwards. Null when it has expired,
   * was used or never was, or what is stored is no ticket (it is used up all the same).
   */
  async redeem(value: string): Promise<Ticket | null> {
    if (!isToken(value)) return null;
    const stored = await this.redis.getdel(ticketKey(value));
    return stored === null ? null : readJson(stored, ticketSchema);
  }
}
