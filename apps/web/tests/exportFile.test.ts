// The file a score is exported to (docs/spec/import-export.md, section 3): its name, and what is in it.
import type { ScoreJSON } from "@studio/score-model";
import { expect, test } from "vitest";

import { exportedFile, exportName } from "../src/exportFile";
import { strings } from "../src/strings";

test("the file is named after the score's title, with the format's extension", () => {
  expect(exportName("夜曲", "gp7")).toBe("夜曲.gp");
  expect(exportName("夜曲", "midi")).toBe("夜曲.mid");
});

test("each character a file name may not hold becomes an underscore", () => {
  expect(exportName('a<b>c:d"e/f\\g|h?i*j', "gp7")).toBe("a_b_c_d_e_f_g_h_i_j.gp");
  expect(exportName("tab\there\u0000\u007f", "midi")).toBe("tab_here__.mid");
});

test("a score with no title is exported as untitled", () => {
  expect(exportName("", "gp7")).toBe(`${strings.score.untitled}.gp`);
});

const score: ScoreJSON = {
  schemaVersion: 1,
  title: "曲",
  bars: [{ id: "bar", timeSig: { numerator: 4, denominator: 4 }, tempo: 120 }],
  parts: [{ id: "bass", name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28], capo: 0, program: 33, staves: [{ clef: "tab" }], content: {} }],
};

test("a Guitar Pro 7 file is a zip, a MIDI file starts with MThd", () => {
  const gp = exportedFile(score, "gp7");
  expect(gp.name).toBe("曲.gp");
  expect([...gp.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
  const midi = exportedFile(score, "midi");
  expect(midi.name).toBe("曲.mid");
  expect(midi.type).toBe("audio/midi");
  expect(new TextDecoder().decode(midi.bytes.slice(0, 4))).toBe("MThd");
});
