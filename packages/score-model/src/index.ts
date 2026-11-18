// The score document: its schema, reading and writing it, the editing commands and the checks on
// it. No DOM here: the server and the web app share this package.
export * from "./build";
export * from "./changes";
export * from "./commands";
// The rest of depth.ts is the model's own: how reading and the commands copy a value.
export { dropTooDeep, MAX_VALUE_DEPTH, ownFields, updateWithinDepth } from "./depth";
export * from "./flags";
export * from "./migrations";
export * from "./navigation";
export * from "./phrases";
export * from "./presets";
export * from "./read";
export * from "./schema";
export * from "./selection";
