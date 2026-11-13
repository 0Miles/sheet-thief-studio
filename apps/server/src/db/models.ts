// The tables as Sequelize models (docs/spec/accounts.md, section 1.2). Columns are snake_case
// in Postgres and camelCase here. The tables themselves come from the migrations, never from
// `sync()`.
import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
} from "sequelize";

/** Someone who can log in, created by an admin (or, for the first admin, by the CLI). */
export class Account extends Model<InferAttributes<Account>, InferCreationAttributes<Account>> {
  declare id: CreationOptional<string>;
  declare username: string;
  declare displayName: string;
  declare isAdmin: CreationOptional<boolean>;
  declare disabledAt: CreationOptional<Date | null>;
  declare mustChangePassword: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** The ways an account logs in: `password` (subject: the account id) or `karyl-chan` (ADR 0004). */
export type Provider = "password" | "karyl-chan";

export class Identity extends Model<InferAttributes<Identity>, InferCreationAttributes<Identity>> {
  declare id: CreationOptional<string>;
  declare accountId: ForeignKey<Account["id"]>;
  declare provider: Provider;
  declare subject: string;
  /** The argon2id hash; only a password has one. */
  declare secretHash: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

/** Bind the models to a connection. The classes are shared, so a process uses one connection. */
export function initModels(sequelize: Sequelize): void {
  Account.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      username: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      displayName: { type: DataTypes.STRING(50), allowNull: false },
      isAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      disabledAt: { type: DataTypes.DATE, allowNull: true },
      mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: "accounts", underscored: true },
  );
  Identity.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      provider: { type: DataTypes.STRING(16), allowNull: false },
      subject: { type: DataTypes.STRING(255), allowNull: false },
      secretHash: { type: DataTypes.TEXT, allowNull: true },
      createdAt: DataTypes.DATE,
    },
    { sequelize, tableName: "identities", underscored: true, updatedAt: false },
  );
  Account.hasMany(Identity, { foreignKey: { name: "accountId", allowNull: false }, as: "identities" });
  Identity.belongsTo(Account, { foreignKey: { name: "accountId", allowNull: false }, as: "account" });
}
