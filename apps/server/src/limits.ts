// The size limits of the server, in one place (docs/spec/security.md, section 5).
import { MAX_FRAGMENT_BYTES } from "@studio/score-model";

// The most a fragment takes, 1 MB of JSON: defined in score-model, which the web app reads it from too.
export { MAX_FRAGMENT_BYTES };

export const MB = 1024 * 1024;

/** The body of a JSON request that carries no fragment. */
export const JSON_BODY_LIMIT = 64 * 1024;

/** A body that carries a fragment: the fragment's 1 MB and room for the rest. */
export const FRAGMENT_BODY_LIMIT = MAX_FRAGMENT_BYTES + JSON_BODY_LIMIT;

/** One image sent to be recognized, and all the images of one recognition (docs/spec/recognizer.md, section 4). */
export const RECOGNITION_IMAGE_BYTES = 10 * MB;
export const RECOGNITION_IMAGES_BYTES = 40 * MB;

/** The body of `POST /api/recognitions`: the images and room for what multipart/form-data wraps them in. */
export const RECOGNITION_BODY_LIMIT = RECOGNITION_IMAGES_BYTES + JSON_BODY_LIMIT;

/** The most the server reads of the recognizer's answer: far more than a fragment of 1 MB is made of. */
export const RECOGNIZER_ANSWER_LIMIT = 32 * MB;

/**
 * One WebSocket message on /collab; a connection that sends more is closed. Restoring a version
 * sends its whole content as one message, so this is also the most a version holds (versions.ts).
 */
export const WEBSOCKET_MESSAGE_LIMIT = 8 * MB;
