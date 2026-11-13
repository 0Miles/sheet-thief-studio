// Accounts and the ways they log in (docs/spec/accounts.md, section 1.2; ADR 0004).
import { DataTypes, type QueryInterface } from "sequelize";

type Step = { context: QueryInterface };

export async function up({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "accounts",
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        username: { type: DataTypes.STRING(32), allowNull: false, unique: true },
        display_name: { type: DataTypes.STRING(50), allowNull: false },
        is_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        disabled_at: { type: DataTypes.DATE, allowNull: true },
        // Safe by default: an account made without saying otherwise must choose its own password.
        must_change_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.createTable(
      "identities",
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        account_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "accounts", key: "id" },
          onDelete: "CASCADE",
        },
        provider: { type: DataTypes.STRING(16), allowNull: false },
        subject: { type: DataTypes.STRING(255), allowNull: false },
        secret_hash: { type: DataTypes.TEXT, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.addConstraint("identities", {
      type: "unique",
      fields: ["provider", "subject"],
      name: "identities_provider_subject_key",
      transaction,
    });
    await queryInterface.addConstraint("identities", {
      type: "check",
      fields: ["provider"],
      where: { provider: ["password", "karyl-chan"] },
      name: "identities_provider_check",
      transaction,
    });
    // Only a password has a secret.
    await queryInterface.sequelize.query(
      "ALTER TABLE identities ADD CONSTRAINT identities_secret_hash_check CHECK ((provider = 'password') = (secret_hash IS NOT NULL))",
      { transaction },
    );
    await queryInterface.addIndex("identities", ["account_id"], { name: "identities_account_id_idx", transaction });
  });
}

export async function down({ context: queryInterface }: Step): Promise<void> {
  await queryInterface.dropTable("identities");
  await queryInterface.dropTable("accounts");
}
