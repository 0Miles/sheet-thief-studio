// The part presets (docs/spec/commands.md, section 10): what a new part, or a new blank phrase,
// starts as, and the tuning options of a fretted part. The names of the presets in menus are texts
// of the interface, kept in the web app's strings by preset id; the names parts get are content of
// the score, written by the server, so they are here.
import { STANDARD_GUITAR } from "./commands";
import type { PartJSON } from "./schema";

export type PartPreset = Pick<PartJSON, "kind" | "tuning" | "staves" | "program">;

export const PART_PRESETS = {
  guitar6: { kind: "fretted", tuning: [...STANDARD_GUITAR], staves: [{ clef: "tab" }], program: 25 },
  guitar7: { kind: "fretted", tuning: [...STANDARD_GUITAR, 35], staves: [{ clef: "tab" }], program: 25 },
  bass4: { kind: "fretted", tuning: [43, 38, 33, 28], staves: [{ clef: "tab" }], program: 33 },
  bass5: { kind: "fretted", tuning: [43, 38, 33, 28, 23], staves: [{ clef: "tab" }], program: 33 },
  drums: { kind: "percussion", tuning: [], staves: [{ clef: "neutral" }], program: 0 },
  keys: { kind: "pitched", tuning: [], staves: [{ clef: "treble" }, { clef: "bass" }], program: 0 },
  vocals: { kind: "pitched", tuning: [], staves: [{ clef: "treble" }], program: 53 },
} as const satisfies Record<string, PartPreset>;

export type PartPresetId = keyof typeof PART_PRESETS;

/** The presets in the order of the table. */
export const PART_PRESET_IDS = Object.keys(PART_PRESETS) as [PartPresetId, ...PartPresetId[]];

/** The name a new part of each preset is numbered under: seven-string guitars share the guitars', five-string basses the basses'. */
export const PRESET_BASE_NAMES: Record<PartPresetId, string> = {
  guitar6: "吉他",
  guitar7: "吉他",
  bass4: "貝斯",
  bass5: "貝斯",
  drums: "鼓",
  keys: "鍵盤",
  vocals: "人聲",
};

/**
 * The names of new parts of these presets, in order, numbered after the parts the score already
 * has (`taken`): 「吉他 1」「吉他 2」, then 「吉他 3」 when 「吉他 2」 is the highest guitar there.
 */
export function partNames(presets: readonly PartPresetId[], taken: Iterable<string> = []): string[] {
  const highest = new Map<string, number>();
  const count = (name: string) => {
    const match = /^(.+) ([1-9][0-9]*)$/.exec(name);
    if (match === null) return;
    const [, base, number] = match as unknown as [string, string, string];
    highest.set(base, Math.max(highest.get(base) ?? 0, Number(number)));
  };
  for (const name of taken) count(name);
  return presets.map((preset) => {
    const base = PRESET_BASE_NAMES[preset];
    const name = `${base} ${(highest.get(base) ?? 0) + 1}`;
    count(name);
    return name;
  });
}

/**
 * The tuning options a fretted part offers besides setting every string by hand (custom); they
 * follow from the standard tuning of its number of strings.
 */
export const TUNING_OPTIONS = ["standard", "drop", "halfDown", "wholeDown"] as const;
export type TuningOption = (typeof TUNING_OPTIONS)[number];

/** The preset whose tuning is the standard one of each number of strings a fretted part can have. */
const STANDARD_OF_STRINGS: Record<number, PartPresetId> = { 4: "bass4", 5: "bass5", 6: "guitar6", 7: "guitar7" };

/** The tuning of this option for a fretted part of this many strings (4 to 7), from the first string. */
export function tuningFor(option: TuningOption, strings: number): number[] {
  const preset = STANDARD_OF_STRINGS[strings];
  if (preset === undefined) throw new RangeError(`no fretted part has ${strings} strings`);
  const standard = [...PART_PRESETS[preset].tuning];
  switch (option) {
    case "standard":
      return standard;
    case "drop":
      return standard.map((pitch, index) => (index === standard.length - 1 ? pitch - 2 : pitch));
    case "halfDown":
      return standard.map((pitch) => pitch - 1);
    case "wholeDown":
      return standard.map((pitch) => pitch - 2);
  }
}

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The name of a MIDI pitch, middle C (60) being C4: how a string of a custom tuning is shown. */
export function pitchName(pitch: number): string {
  return `${PITCH_CLASSES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
