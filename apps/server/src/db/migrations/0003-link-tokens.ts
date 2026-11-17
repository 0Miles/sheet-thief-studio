// The read-only link of a score (docs/spec/accounts.md, section 7): its token, kept in plain text
// so that the Owner can copy it again. At most one per score; none until the Owner makes one.
import { DataTypes, type QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

export async function up({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // 32 random bytes in base64url (src/tokens.ts). Unique: a token opens one score only.
    await queryInterface.addColumn("scores", "link_token", { type: DataTypes.STRING(43), allowNull: true }, { transaction });
    await queryInterface.addConstraint("scores", { type: "unique", fields: ["link_token"], name: "scores_link_token_key", transaction });
  });
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.removeColumn("scores", "link_token");
}
