// A version a member makes of the score as it is now, with a name (docs/spec/collab.md, 8.3, M5):
// one more reason a version is made, besides the ones the server has on its own.
import type { QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

const CONSTRAINT = "versions_reason_check";

async function allowReasons(queryInterface: QueryInterface, reasons: string[]): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeConstraint("versions", CONSTRAINT, { transaction });
    await queryInterface.addConstraint("versions", { type: "check", fields: ["reason"], where: { reason: reasons }, name: CONSTRAINT, transaction });
  });
}

export async function up({ context: queryInterface }: Step): Promise<void> {
  await allowReasons(queryInterface, ["last_disconnect", "interval", "before_restore", "manual"]);
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  // A manual version has no place under the older rule: it goes with it.
  await queryInterface.sequelize.query("DELETE FROM versions WHERE reason = 'manual'");
  await allowReasons(queryInterface, ["last_disconnect", "interval", "before_restore"]);
}
