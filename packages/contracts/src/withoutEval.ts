// zod for the web app, set to parse every schema without code made as the page runs: the web
// app's build resolves every import of "zod" (of this package, of score-model, of its own) to this
// module (apps/web/vite.config.ts). Zod otherwise tries `new Function("")` as the first object
// schema is built, to see whether it may compile its parsers; under the page's Content Security
// Policy that is refused, harmlessly, but reported as a violation (docs/spec/security.md, section
// 7). As the module zod is imported through, it is set before any schema is built, whatever chunk
// the build puts zod and the schemas in: an import at the top of main.ts was not, once `/` loaded
// score-render on demand (#70). The server imports zod itself and keeps the compiled parsers.
import { z } from "zod/v4";

z.config({ jitless: true });

export * from "zod/v4";
