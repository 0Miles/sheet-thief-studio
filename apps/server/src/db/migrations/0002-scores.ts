// Scores and who is a member of each (docs/spec/collab.md, 1.1; docs/spec/accounts.md, 1.2).
import { DataTypes, type QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

export async function up({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "scores",
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        // Mirrored from the document's meta, for the lists.
        title: { type: DataTypes.STRING(100), allowNull: false },
        artist: { type: DataTypes.STRING(100), allowNull: true },
        // The whole Yjs state (`Y.encodeStateAsUpdate`): the one truth about the content.
        doc_state: { type: DataTypes.BLOB, allowNull: false },
        schema_version: { type: DataTypes.INTEGER, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        deleted_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.createTable(
      "score_members",
      {
        score_id: {
          type: DataTypes.UUID,
          allowNull: false,
          primaryKey: true,
          references: { model: "scores", key: "id" },
          onDelete: "CASCADE",
        },
        account_id: {
          type: DataTypes.UUID,
          allowNull: false,
          primaryKey: true,
          references: { model: "accounts", key: "id" },
          onDelete: "CASCADE",
        },
        role: { type: DataTypes.STRING(8), allowNull: false },
        added_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.addConstraint("score_members", {
      type: "check",
      fields: ["role"],
      where: { role: ["owner", "editor", "viewer"] },
      name: "score_members_role_check",
      transaction,
    });
    // Exactly one Owner per score: at most one here, and creating a score adds its Owner.
    await queryInterface.sequelize.query("CREATE UNIQUE INDEX score_members_one_owner ON score_members (score_id) WHERE role = 'owner'", { transaction });
    // "My scores": the scores of an account.
    await queryInterface.addIndex("score_members", ["account_id"], { name: "score_members_account_id_idx", transaction });
  });
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.dropTable("score_members");
  await queryInterface.dropTable("scores");
}
