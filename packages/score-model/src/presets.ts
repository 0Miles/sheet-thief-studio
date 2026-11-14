// The part presets (docs/spec/commands.md, section 10): what a new part, or a new blank phrase,
// starts as. Their names are texts of the interface, kept in the web app's strings by preset id.
import type { PartJSON } from "./schema";

export type PartPreset = Pick<PartJSON, "kind" | "tuning" | "staves" | "program">;

export const PART_PRESETS = {
  guitar6: { kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], staves: [{ clef: "tab" }], program: 25 },
  guitar7: { kind: "fretted", tuning: [64, 59, 55, 50, 45, 40, 35], staves: [{ clef: "tab" }], program: 25 },
  bass4: { kind: "fretted", tuning: [43, 38, 33, 28], staves: [{ clef: "tab" }], program: 33 },
  bass5: { kind: "fretted", tuning: [43, 38, 33, 28, 23], staves: [{ clef: "tab" }], program: 33 },
  drums: { kind: "percussion", tuning: [], staves: [{ clef: "neutral" }], program: 0 },
  keys: { kind: "pitched", tuning: [], staves: [{ clef: "treble" }, { clef: "bass" }], program: 0 },
  vocals: { kind: "pitched", tuning: [], staves: [{ clef: "treble" }], program: 53 },
} as const satisfies Record<string, PartPreset>;

export type PartPresetId = keyof typeof PART_PRESETS;
