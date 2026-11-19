// The clock of the database: what decides when a row is old enough to delete for good, since the
// clock of a process may jump.
import { literal } from "sequelize";

/** The clock of the database, as a value of a date column. */
export const NOW = literal("now()") as unknown as Date;

/** The moment that many days ago, by the clock of the database. */
export const daysAgo = (days: number) => literal(`now() - make_interval(days => ${days})`);
