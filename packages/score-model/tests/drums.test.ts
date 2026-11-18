// The 18 drum pieces the interface offers (docs/spec/schema.md, 7.1): the one table the editor,
// the renderer and the measurements read.
import { expect, test } from "vitest";

import { DRUM_PIECES, drumLineOf } from "../src/index";

test("the table holds the 18 pieces checked in M0: their key, the MIDI key they sound and their staff position", () => {
  // schema.md 7.1, as the spike checked it against alphaTab (spike-report.md, S6).
  expect(Object.values(DRUM_PIECES).map(({ id, midi, line }) => [`p${id}`, midi, line])).toEqual([
    ["p36", 36, 7],
    ["p38", 38, 3],
    ["p37", 37, 3],
    ["p91", 38, 3],
    ["p42", 42, -1],
    ["p92", 46, -1],
    ["p46", 46, -1],
    ["p44", 44, 9],
    ["p48", 48, 2],
    ["p47", 47, 4],
    ["p45", 45, 5],
    ["p43", 43, 6],
    ["p49", 49, -2],
    ["p51", 51, 0],
    ["p53", 53, 0],
    ["p52", 52, -3],
    ["p55", 55, -2],
    ["p56", 56, 0],
  ]);
});

test("the staff position of a piece is told by its id; an id the interface does not offer has none", () => {
  expect(drumLineOf(DRUM_PIECES.hiHatPedal.id)).toBe(9);
  expect(drumLineOf(DRUM_PIECES.rimShot.id)).toBe(3);
  // Acoustic kick: alphaTab knows it, the interface does not offer it.
  expect(drumLineOf(35)).toBeUndefined();
});
