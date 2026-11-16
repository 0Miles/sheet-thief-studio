// The size limits more than one module reads (docs/spec/security.md, section 5).

export const MB = 1024 * 1024;

/** The body of a JSON request that carries no fragment. */
export const JSON_BODY_LIMIT = 64 * 1024;

/**
 * One WebSocket message on /collab; a connection that sends more is closed. Restoring a version
 * sends its whole content as one message, so this is also the most a version holds (versions.ts).
 */
export const WEBSOCKET_MESSAGE_LIMIT = 8 * MB;
