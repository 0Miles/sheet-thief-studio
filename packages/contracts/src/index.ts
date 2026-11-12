// Shapes of what the API sends and receives, shared by the server and the web app.
import { z } from "zod";

export const health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof health>;
