// The tables as Sequelize models (docs/spec/accounts.md, section 1.2; docs/spec/collab.md, 1.1). Columns are snake_case
// in Postgres and camelCase here. The tables themselves come from the migrations, never from
// `sync()`.
import type { BarsFragment, PartKind, RecognitionError, RecognitionReport, RecognitionStatus, Role, VersionReason } from "@studio/contracts";
import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  literal,
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

/** A score: its Yjs state and what the lists show of it. Members are in `score_members`. */
export class Score extends Model<InferAttributes<Score>, InferCreationAttributes<Score>> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare artist: CreationOptional<string | null>;
  /** `Y.encodeStateAsUpdate` of the whole document. */
  declare docState: Buffer;
  declare schemaVersion: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  /** Set when the score is deleted; a deleted score is not found by anyone (docs/spec/security.md, 8). */
  declare deletedAt: CreationOptional<Date | null>;
  /** The token of its read-only link, in plain text so that the Owner can copy it again; null when it has none. */
  declare linkToken: CreationOptional<string | null>;
}

export class ScoreMember extends Model<InferAttributes<ScoreMember>, InferCreationAttributes<ScoreMember>> {
  declare scoreId: ForeignKey<Score["id"]>;
  declare accountId: ForeignKey<Account["id"]>;
  declare role: Role;
  declare addedAt: CreationOptional<Date>;
}

/** A phrase of an account's library (docs/spec/phrases.md, 4.1): a fragment of bars, and what the lists show of it. */
export class Phrase extends Model<InferAttributes<Phrase>, InferCreationAttributes<Phrase>> {
  declare id: CreationOptional<string>;
  declare ownerId: ForeignKey<Account["id"]>;
  declare name: string;
  declare kind: PartKind;
  /** Fretted phrases only. */
  declare stringCount: number | null;
  /** Pitched phrases only. */
  declare staffCount: number | null;
  declare barCount: number;
  declare content: BarsFragment;
  declare revision: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Why a version was made (docs/spec/collab.md, 8.3): `manual` is a member's, named as it is made. */
export type { VersionReason };

/** A version of a score (docs/spec/collab.md, section 8): its whole content at one moment. */
export class Version extends Model<InferAttributes<Version>, InferCreationAttributes<Version>> {
  declare id: CreationOptional<string>;
  declare scoreId: ForeignKey<Score["id"]>;
  /** The `schemaVersion` of the content. */
  declare schemaVersion: number;
  /** The `ScoreJSON`, gzipped. */
  declare content: Buffer;
  /** SHA-256 of the `ScoreJSON` with its keys sorted, in hex. */
  declare contentHash: string;
  /** Of the JSON before it is gzipped. */
  declare byteSize: number;
  declare reason: VersionReason;
  /** Null for an automatic version. */
  declare name: CreationOptional<string | null>;
  declare createdBy: CreationOptional<string | null>;
  /** By the clock of the database, at the insert. */
  declare createdAt: CreationOptional<Date>;
}

/** A recognition an account started (docs/spec/recognizer.md, 7.1): its result once the recognizer answers. */
export class Recognition extends Model<InferAttributes<Recognition>, InferCreationAttributes<Recognition>> {
  declare id: CreationOptional<string>;
  declare accountId: ForeignKey<Account["id"]>;
  declare status: RecognitionStatus;
  /** How many images it reads. */
  declare pageCount: number;
  /** Failed only. */
  declare error: CreationOptional<RecognitionError | null>;
  /** Succeeded only: checked with the phrase schema before it is written. */
  declare fragment: CreationOptional<BarsFragment | null>;
  declare report: CreationOptional<RecognitionReport | null>;
  /** By the clock of the database: what the 7 days are counted from. */
  declare createdAt: CreationOptional<Date>;
  declare finishedAt: CreationOptional<Date | null>;
}

/** One image of a recognition, its page counted from 1. */
export class RecognitionImage extends Model<InferAttributes<RecognitionImage>, InferCreationAttributes<RecognitionImage>> {
  declare recognitionId: ForeignKey<Recognition["id"]>;
  declare page: number;
  declare mime: string;
  declare data: Buffer;
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
  Score.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      title: { type: DataTypes.STRING(100), allowNull: false },
      artist: { type: DataTypes.STRING(100), allowNull: true },
      docState: { type: DataTypes.BLOB, allowNull: false },
      schemaVersion: { type: DataTypes.INTEGER, allowNull: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
      deletedAt: { type: DataTypes.DATE, allowNull: true },
      linkToken: { type: DataTypes.STRING(43), allowNull: true, unique: true },
    },
    { sequelize, tableName: "scores", underscored: true },
  );
  ScoreMember.init(
    {
      scoreId: { type: DataTypes.UUID, primaryKey: true },
      accountId: { type: DataTypes.UUID, primaryKey: true },
      role: { type: DataTypes.STRING(8), allowNull: false },
      addedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { sequelize, tableName: "score_members", underscored: true, timestamps: false },
  );
  Score.hasMany(ScoreMember, { foreignKey: { name: "scoreId", allowNull: false }, as: "members" });
  ScoreMember.belongsTo(Score, { foreignKey: { name: "scoreId", allowNull: false }, as: "score" });
  ScoreMember.belongsTo(Account, { foreignKey: { name: "accountId", allowNull: false }, as: "account" });
  Phrase.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      ownerId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      stringCount: { type: DataTypes.INTEGER, allowNull: true },
      staffCount: { type: DataTypes.INTEGER, allowNull: true },
      barCount: { type: DataTypes.INTEGER, allowNull: false },
      content: { type: DataTypes.JSONB, allowNull: false },
      revision: { type: DataTypes.INTEGER, allowNull: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: "phrases", underscored: true },
  );
  Version.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      scoreId: { type: DataTypes.UUID, allowNull: false },
      schemaVersion: { type: DataTypes.INTEGER, allowNull: false },
      content: { type: DataTypes.BLOB, allowNull: false },
      contentHash: { type: DataTypes.CHAR(64), allowNull: false },
      byteSize: { type: DataTypes.INTEGER, allowNull: false },
      reason: { type: DataTypes.STRING(16), allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: true },
      createdBy: { type: DataTypes.UUID, allowNull: true },
      // The clock of the database at the insert, as the table's own default.
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: literal("clock_timestamp()") },
    },
    { sequelize, tableName: "versions", underscored: true, timestamps: false },
  );
  Recognition.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      accountId: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false },
      pageCount: { type: DataTypes.INTEGER, allowNull: false },
      error: { type: DataTypes.JSONB, allowNull: true },
      fragment: { type: DataTypes.JSONB, allowNull: true },
      report: { type: DataTypes.JSONB, allowNull: true },
      // The clock of the database, as the table's own default.
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: literal("now()") },
      finishedAt: { type: DataTypes.DATE, allowNull: true },
    },
    { sequelize, tableName: "recognitions", underscored: true, timestamps: false },
  );
  RecognitionImage.init(
    {
      recognitionId: { type: DataTypes.UUID, primaryKey: true },
      page: { type: DataTypes.INTEGER, primaryKey: true },
      mime: { type: DataTypes.STRING(16), allowNull: false },
      data: { type: DataTypes.BLOB, allowNull: false },
    },
    { sequelize, tableName: "recognition_images", underscored: true, timestamps: false },
  );
  Recognition.hasMany(RecognitionImage, { foreignKey: { name: "recognitionId", allowNull: false }, as: "images" });
  RecognitionImage.belongsTo(Recognition, { foreignKey: { name: "recognitionId", allowNull: false }, as: "recognition" });
}
