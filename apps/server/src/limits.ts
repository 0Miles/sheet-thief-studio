// The size limits of the server, in one place (docs/spec/security.md, section 5).
import { recognitionLimits } from "@studio/contracts";
import { MAX_FRAGMENT_BYTES, MAX_IMPORT_BYTES } from "@studio/score-model";

// The most a fragment takes, 1 MB of JSON, and an imported score, 5 MB: defined in score-model,
// which the web app reads them from too.
export { MAX_FRAGMENT_BYTES, MAX_IMPORT_BYTES };

/** The most images one recognition reads: defined in contracts, which the web app reads it from too. */
export const MAX_RECOGNITION_IMAGES = recognitionLimits.images.max;

export const MB = 1024 * 1024;

/** The body of a JSON request that carries no fragment. */
export const JSON_BODY_LIMIT = 64 * 1024;

/** What a body that carries something of a limit of its own may take besides it: the rest of the request. */
export const BODY_MARGIN = 64 * 1024;

/** A body that carries a fragment: the fragment's 1 MB and room for the rest. */
export const FRAGMENT_BODY_LIMIT = MAX_FRAGMENT_BYTES + BODY_MARGIN;

/** The body of `POST /api/scores/import`: the score's 5 MB and room for the rest. */
export const IMPORT_BODY_LIMIT = MAX_IMPORT_BYTES + BODY_MARGIN;

/**
 * One image sent to be recognized, and all the images of one recognition (docs/spec/recognizer.md,
 * section 4): defined in contracts, which the web app reads them from too.
 */
export const RECOGNITION_IMAGE_BYTES = recognitionLimits.imageBytes;
export const RECOGNITION_IMAGES_BYTES = recognitionLimits.imagesBytes;

/** The body of `POST /api/recognitions`: the images and room for what multipart/form-data wraps them in. */
export const RECOGNITION_BODY_LIMIT = RECOGNITION_IMAGES_BYTES + BODY_MARGIN;

/** A dispatch of the karyl-chan bot carries an interaction, larger than an API request may be, never close to this. */
export const DISPATCH_BODY_LIMIT = 1 * MB;

/** The most the server reads of the recognizer's answer: far more than a fragment of 1 MB is made of. */
export const RECOGNIZER_ANSWER_LIMIT = 32 * MB;

/**
 * One WebSocket message on /collab; a connection that sends more is closed. Restoring a version
 * sends its whole content as one message, so this is also the most a version holds (versions.ts).
 */
export const WEBSOCKET_MESSAGE_LIMIT = 8 * MB;
