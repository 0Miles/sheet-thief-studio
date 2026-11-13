// Collab tickets (docs/spec/collab.md, section 3; ADR 0005): what a provider shows /collab to open
// a score. A ticket is fetched again for every connection, lasts 60 seconds and opens once.
import { randomBytes } from "node:crypto";

import type { Redis } from "ioredis";

import type { Role } from "./db/models";

export const TICKET_TTL_SECONDS = 60;

/** Who the ticket lets in, to which score, and with the role they had when it was given. */
export interface Ticket {
  scoreId: string;
  accountId: string;
  sessionId: string;
  role: Role;
}

/** 32 random bytes in base64url. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;

const ticketKey = (ticket: string) => `collab-ticket:${ticket}`;

export class CollabTickets {
  constructor(private readonly redis: Redis) {}

  async issue(ticket: Ticket): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    await this.redis.set(ticketKey(value), JSON.stringify(ticket), "EX", TICKET_TTL_SECONDS);
    return value;
  }

  /** What the ticket was given for, once: the ticket is gone afterwards. Null when it has expired, was used or never was. */
  async redeem(value: string): Promise<Ticket | null> {
    if (!TICKET.test(value)) return null;
    const stored = await this.redis.getdel(ticketKey(value));
    return stored === null ? null : (JSON.parse(stored) as Ticket);
  }
}
