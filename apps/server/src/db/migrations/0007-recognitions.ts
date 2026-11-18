// Recognitions (docs/spec/recognizer.md, 7 and 7.1): one row per recognition an account started,
// its result once the recognizer answers, and its images, one row per page. Both go when the
// recognition is saved as a phrase or discarded, or after 7 days.
import { DataTypes, type QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

export async function up({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "recognitions",
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        // Only this account reaches it; it goes with the account.
        account_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "accounts", key: "id" },
          onDelete: "CASCADE",
        },
        status: { type: DataTypes.STRING(16), allowNull: false },
        // How many images it reads: its pages, from 1.
        page_count: { type: DataTypes.INTEGER, allowNull: false },
        // Failed only: `{ code, params, pages }`.
        error: { type: DataTypes.JSONB, allowNull: true },
        // Succeeded only: the fragment of bars, checked with the phrase schema, and the report beside it.
        fragment: { type: DataTypes.JSONB, allowNull: true },
        report: { type: DataTypes.JSONB, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        finished_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.addConstraint("recognitions", {
      type: "check",
      fields: ["status"],
      where: { status: ["running", "succeeded", "failed"] },
      name: "recognitions_status_check",
      transaction,
    });
    // At most one running per account (docs/spec/recognizer.md, section 7).
    await queryInterface.addIndex("recognitions", {
      fields: ["account_id"],
      unique: true,
      where: { status: "running" },
      name: "recognitions_one_running_per_account",
      transaction,
    });
    // An account's recognitions, the latest first.
    await queryInterface.addIndex("recognitions", { fields: ["account_id", { name: "created_at", order: "DESC" }], name: "recognitions_account_id_created_at_idx", transaction });
    // The job that deletes the ones older than 7 days.
    await queryInterface.addIndex("recognitions", { fields: ["created_at"], name: "recognitions_created_at_idx", transaction });

    await queryInterface.createTable(
      "recognition_images",
      {
        recognition_id: {
          type: DataTypes.UUID,
          allowNull: false,
          primaryKey: true,
          references: { model: "recognitions", key: "id" },
          onDelete: "CASCADE",
        },
        page: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
        // image/png, image/jpeg or image/webp, as told by the bytes the file starts with.
        mime: { type: DataTypes.STRING(16), allowNull: false },
        data: { type: DataTypes.BLOB, allowNull: false },
      },
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.dropTable("recognition_images");
  await queryInterface.dropTable("recognitions");
}
