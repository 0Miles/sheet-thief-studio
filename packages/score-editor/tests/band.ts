// A score with a part of each kind, to move through and change beats on (docs/spec/commands.md,
// sections 3 and 5.3): a guitar on one staff, a keyboard on two, and drums, over three bars.
import { addPart, createScore, type Cursor, cursorAt, docToJson, insertBars, insertBeat, type NoteJSON, type NoteValue, setNote } from "@studio/score-model";
import * as Y from "yjs";

import { createEditorSession, type KeyPlatform, type SessionHint } from "../src/index";
import { keyOf, type Modifiers } from "./support";

export type PartName = "guitar" | "keys" | "drums";

/** The modifiers of each abstract one, on each platform (docs/spec/keymap.md, 1.3). */
export const MODIFIERS = {
  other: { mod: { ctrlKey: true }, nav: { ctrlKey: true }, alt: { altKey: true } },
  mac: { mod: { metaKey: true }, nav: { altKey: true }, alt: { altKey: true } },
} as const satisfies Record<KeyPlatform, Record<string, Modifiers>>;

export const PLATFORMS: KeyPlatform[] = ["other", "mac"];

/**
 * Three bars of 4/4. The first: the guitar holds a half and a quarter (not full); the keyboard's
 * upper staff four quarters, the second voice of that staff a half, its lower staff a whole; the
 * drums nothing. The second bar is empty. The last: the guitar holds a whole, the keyboard's
 * upper staff two quarters, the drums a quarter. The cursor starts on the guitar's first beat.
 */
export function band(platform: KeyPlatform = "other") {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count: 3 });
  const partIds: Record<PartName, string> = {
    guitar: addPart(doc, { name: "Guitar", kind: "fretted" }),
    keys: addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] }),
    drums: addPart(doc, { name: "Drums", kind: "percussion" }),
  };
  const notes: Record<PartName, [string, NoteJSON]> = { guitar: ["s1", { fret: 5 }], keys: ["n60", {}], drums: ["p38", {}] };
  /** The ids of the beats of each voice of each bar of each part, as written. */
  const ids = new Map<string, string[]>();
  const write = (part: PartName, bar: number, voice: string, values: NoteValue[]) => {
    let cursor: Cursor = { partId: partIds[part], barId: barIds[bar]!, voice, beatId: null, at: "after", line: 1 };
    ids.set(
      `${part}:${bar}:${voice}`,
      values.map((value) => {
        cursor = insertBeat(doc, { ...cursor, at: "after" }, { value });
        setNote(doc, cursor, ...notes[part]);
        return cursor.beatId!;
      }),
    );
  };
  write("guitar", 0, "0:0", [2, 4]);
  write("keys", 0, "0:0", [4, 4, 4, 4]);
  write("keys", 0, "0:1", [2]);
  write("keys", 0, "1:0", [1]);
  write("guitar", 2, "0:0", [1]);
  write("keys", 2, "0:0", [4, 4]);
  write("drums", 2, "0:0", [4]);

  const session = createEditorSession(doc, { platform, cursor: cursorAt(doc, partIds.guitar, barIds[0]!) });
  const hints: SessionHint[] = [];
  session.onHint((hint) => hints.push(hint));
  const press = (key: string, modifiers: Modifiers = {}): boolean => session.press(keyOf(key, modifiers));
  const nameOf = (partId: string) => (Object.keys(partIds) as PartName[]).find((name) => partIds[name] === partId);
  /** Where the cursor is: its part, its bar, its voice, the index of its beat (-1 for none) and on or after it. */
  const place = () => {
    const { partId, barId, voice, beatId, at } = session.cursor!;
    const bar = barIds.indexOf(barId);
    const beats = ids.get(`${nameOf(partId)}:${bar}:${voice}`) ?? [];
    return [nameOf(partId), bar, voice, beatId === null ? -1 : beats.indexOf(beatId), at] as const;
  };
  /** Put the cursor on a beat (by index; -1 for the append slot of an empty voice), on the line given or its own. */
  const goTo = (part: PartName, bar: number, voice = "0:0", beat = 0, line = session.cursor!.line) => {
    const beatId = beat < 0 ? null : ids.get(`${part}:${bar}:${voice}`)![beat]!;
    session.moveTo({ partId: partIds[part], barId: barIds[bar]!, voice, beatId, at: beatId === null ? "after" : "on", line });
  };
  /** The beats of a voice of a bar of a part, as read. */
  const beats = (part: PartName, bar: number, voice = "0:0") => {
    const index = Object.keys(partIds).indexOf(part);
    return docToJson(doc).parts[index]!.content[barIds[bar]!]?.[voice] ?? [];
  };
  return { doc, session, hints, press, place, goTo, beats, barIds, partIds, ids, mods: MODIFIERS[platform] };
}
