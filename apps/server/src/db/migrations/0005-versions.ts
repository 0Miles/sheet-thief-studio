// The versions of each score (docs/spec/collab.md, 8.2): one row per version, its content the
// whole score as JSON, gzipped. Nothing reads inside the content in the database, hence no jsonb.
import { DataTypes, type QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

export async function up({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "versions",
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        // Deleting a score for good deletes its versions (docs/spec/accounts.md, section 8).
        score_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "scores", key: "id" },
          onDelete: "CASCADE",
        },
        // The `schemaVersion` of the content, to migrate it when it is read.
        schema_version: { type: DataTypes.INTEGER, allowNull: false },
        // The `ScoreJSON`, gzipped.
        content: { type: DataTypes.BLOB, allowNull: false },
        // SHA-256 of the `ScoreJSON` with its keys sorted, in hex: tells a version the same as the latest one.
        content_hash: { type: DataTypes.CHAR(64), allowNull: false },
        // Of the JSON before it is gzipped.
        byte_size: { type: DataTypes.INTEGER, allowNull: false },
        reason: { type: DataTypes.STRING(16), allowNull: false },
        // Given by a member (M5); null for an automatic version, the only ones the retention deletes.
        name: { type: DataTypes.STRING(100), allowNull: true },
        // Who asked for a `before_restore` version; null for the ones the server makes on its own.
        created_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: "accounts", key: "id" },
          onDelete: "SET NULL",
        },
        // The moment of the insert and not the start of its transaction: the versions of a score
        // are made one at a time, and this orders them as they were made.
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("clock_timestamp") },
      },
      { transaction },
    );
    await queryInterface.addConstraint("versions", {
      type: "check",
      fields: ["reason"],
      where: { reason: ["last_disconnect", "interval", "before_restore"] },
      name: "versions_reason_check",
      transaction,
    });
    // The versions of a score, the latest first: the latest one, the list, the oldest ones to delete.
    await queryInterface.addIndex("versions", { fields: ["score_id", { name: "created_at", order: "DESC" }], name: "versions_score_id_created_at_idx", transaction });
  });
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.dropTable("versions");
}
