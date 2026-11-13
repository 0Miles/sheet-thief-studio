// The session on a plain Y.Doc, with other members' changes arriving as updates, as a provider
// would hand them over: the local presence, and undo of only this member's commands.
import { contentOf, cursorAt, insertBeat, partsOf, setFret } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import type { LocalPresence } from "../src/index";
import { sessionOn } from "./support";

/** Another member's copy of the score, and a way to hand their changes to ours. */
function otherMember(doc: Y.Doc) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const send = () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
  return { other, send };
}

test("the local presence is the cursor without a selection, told each time the cursor moves", () => {
  const { session, press } = sessionOn();
  const told: LocalPresence[] = [];
  session.onPresence((presence) => told.push(presence));
  press("5");
  press("ArrowUp");
  expect(session.presence()).toEqual({ cursor: session.cursor, selection: null });
  expect(told.at(-1)).toEqual(session.presence());
  expect(told.map((presence) => presence.cursor?.line)).toEqual([6, 5]);
  session.moveTo(null);
  expect(told.at(-1)).toEqual({ cursor: null, selection: null });
});

test("with no provider, other members' changes merge in, and undo takes back only this member's", () => {
  const { doc, press, beats, partId, barIds } = sessionOn();
  press("5");
  const { other, send } = otherMember(doc);
  const theirs = insertBeat(other, cursorAt(other, partId, barIds[1]!, 1), { value: 8 });
  setFret(other, theirs, 3);
  send();
  expect(beats(1).map((beat) => beat.notes)).toEqual([{ s1: { fret: 3 } }]);
  press("7", 1000);
  press("z", 1000, { ctrlKey: true });
  press("z", 1000, { ctrlKey: true });
  expect(beats(0)).toEqual([]);
  expect(beats(1).map((beat) => beat.notes)).toEqual([{ s1: { fret: 3 } }]);
  press("y", 1000, { ctrlKey: true });
  expect(beats(0).map((beat) => beat.notes)).toEqual([{ s6: { fret: 5 } }]);
});

test("when another member removes the beat under the cursor, the cursor settles and the presence is told", () => {
  const { doc, session, press, beats, partId, barIds } = sessionOn();
  press("5");
  press("ArrowRight");
  press("7");
  const [first, second] = beats().map((beat) => beat.id);
  expect(session.cursor?.beatId).toBe(second);
  const told: LocalPresence[] = [];
  session.onPresence((presence) => told.push(presence));

  const { other, send } = otherMember(doc);
  other.transact(() => contentOf(partsOf(other).get(partId)!).get(barIds[0]!)!.get("0:0")!.delete(1, 1));
  send();
  expect(session.cursor?.beatId).toBe(first);
  expect(told.map((presence) => presence.cursor?.beatId)).toEqual([first]);
});

test("→ from a beat typed in the append slot goes on after it, even when another member's beats arrived after it meanwhile", () => {
  const { doc, press, beats, partId, barIds, cursor } = sessionOn();
  press("1");
  press("+");
  press("ArrowRight");
  press("2");
  const mine = beats()[1]!.id;
  const { other, send } = otherMember(doc);
  setFret(other, { ...cursorAt(other, partId, barIds[0]!, 1), beatId: mine, at: "after" }, 9);
  send();

  press("ArrowRight");
  expect(cursor()).toMatchObject({ beatId: mine, at: "after" });
  press("3");
  const frets = () => beats().map((beat) => beat.notes.s6?.fret ?? beat.notes.s1?.fret);
  expect(frets()).toEqual([1, 2, 3, 9]);

  // Once the cursor has left that beat, → is the plain one again: on to the next beat.
  press("ArrowLeft");
  press("ArrowRight");
  press("ArrowRight");
  expect(cursor()).toMatchObject({ beatId: beats()[3]!.id, at: "on" });
});
