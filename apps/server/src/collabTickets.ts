// Collab tickets (docs/spec/collab.md, section 3; ADR 0005): what a provider shows /collab to open
// a score. A ticket is fetched again for every connection, lasts 60 seconds and opens once.
import type { Role } from "@studio/contracts";
import type { Redis } from "ioredis";

import { isToken, newToken } from "./tokens";

export const TICKET_TTL_SECONDS = 60;

/** A member: their account, the session the ticket was given to, and their role. */
export interface Member {
  kind: "member";
  accountId: string;
  sessionId: string;
  role: Role;
}

/** A guest: the read-only link it came with, and nothing else. */
export interface Guest {
  kind: "guest";
  linkToken: string;
}

/** Who the ticket lets in, to which score: a member, with the role they had when it was given, or a guest. */
export type Ticket = { scoreId: string } & (Member | Guest);

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
