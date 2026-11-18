// For the web app, imported before anything else of this package or of score-model: have every
// schema parse without code made as the page runs. Zod otherwise tries `new Function("")` as the
// first object schema is built, to see whether it may compile its parsers; under the page's
// Content Security Policy that is refused, harmlessly, but reported as a violation
// (docs/spec/security.md, section 7). The server keeps the compiled parsers.
import { z } from "zod";

z.config({ jitless: true });
