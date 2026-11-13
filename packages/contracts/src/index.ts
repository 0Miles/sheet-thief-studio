// Shapes of what the API sends and receives, shared by the server and the web app.
import { z } from "zod";

// The score is defined once, in score-model (docs/adr/0002, addendum): only re-exported here.
export {
  type BarJSON,
  barSchema,
  type BeatJSON,
  beatSchema,
  importedScoreSchema,
  type NoteJSON,
  noteSchema,
  type PartJSON,
  partSchema,
  type ScoreJSON,
  scoreSchema,
} from "@studio/score-model";

export const health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof health>;
