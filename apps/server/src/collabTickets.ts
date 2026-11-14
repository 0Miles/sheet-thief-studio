// Collab tickets (docs/spec/collab.md, section 3; ADR 0005): what a provider shows /collab to open
// a score. A ticket is fetched again for every connection, lasts 60 seconds and opens once.
import type { Role } from "@studio/contracts";
import type { Redis } from "ioredis";

import { isToken, newToken } from "./tokens";

export const TICKET_TTL_SECONDS = 60;

/** Who the ticket lets in, to which score: a member, with the role they had when it was given, or a guest with the score's read-only link. */
export type Ticket = { scoreId: string } & (MemberTicket | LinkTicket);

export interface MemberTicket {
  accountId: string;
  sessionId: string;
  role: Role;
}

export interface LinkTicket {
  linkToken: string;
}

const ticketKey = (ticket: string) => `collab-ticket:${ticket}`;

export class CollabTickets {
  constructor(private readonly redis: Redis) {}

  async issue(ticket: Ticket): Promise<string> {
    const value = newToken();
    await this.redis.set(ticketKey(value), JSON.stringify(ticket), "EX", TICKET_TTL_SECONDS);
    return value;
  }

  /** What the ticket was given for, once: the ticket is gone afterwards. Null when it has expired, was used or never was. */
  async redeem(value: string): Promise<Ticket | null> {
    if (!isToken(value)) return null;
    const stored = await this.redis.getdel(ticketKey(value));
    return stored === null ? null : (JSON.parse(stored) as Ticket);
  }
}
