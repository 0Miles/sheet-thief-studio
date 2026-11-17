// Each account's phrase library (docs/spec/phrases.md, 4.1): one row per phrase, its content a
// fragment of bars. The counts beside the content are what the lists and the compatibility of
// the phrase sidebar read without opening it.
import { DataTypes, type QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

export async function up({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "phrases",
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        owner_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "accounts", key: "id" },
          onDelete: "CASCADE",
        },
        name: { type: DataTypes.STRING(100), allowNull: false },
        kind: { type: DataTypes.STRING(16), allowNull: false },
        // Fretted only: how many strings its tuning has.
        string_count: { type: DataTypes.INTEGER, allowNull: true },
        // Pitched only: how many staves it has.
        staff_count: { type: DataTypes.INTEGER, allowNull: true },
        bar_count: { type: DataTypes.INTEGER, allowNull: false },
        // The fragment of bars, at most 1 MB of JSON (checked by the API).
        content: { type: DataTypes.JSONB, allowNull: false },
        // One more at every write; a write made from an older one is refused.
        revision: { type: DataTypes.INTEGER, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.addConstraint("phrases", {
      type: "check",
      fields: ["kind"],
      where: { kind: ["fretted", "percussion", "pitched"] },
      name: "phrases_kind_check",
      transaction,
    });
    // The library: an account's phrases, most recently updated first.
    await queryInterface.addIndex("phrases", { fields: ["owner_id", { name: "updated_at", order: "DESC" }], name: "phrases_owner_id_updated_at_idx", transaction });
  });
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.dropTable("phrases");
}
