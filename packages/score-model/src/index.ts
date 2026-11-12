// The score document: its Yjs schema, the editing commands and the checks on it. No DOM here:
// the server and the web app share this package.

/** Version of the document schema; a document written by a newer version opens read-only. */
export const SCHEMA_VERSION = 1;
