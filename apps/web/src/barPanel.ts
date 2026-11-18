// What the panel of the cursor's bar shows (docs/spec/commands.md, section 6): the score's and the
// phrase editor's.
import type { LocalPresence } from "@studio/score-editor";
import { DEFAULT_KEY_SIG, keySigAt, type ScoreJSON, tempoAt, voltaRepeatTimes } from "@studio/score-model";

/**
 * The cursor's bar, the bars a selection names, and every value of the panel there; null when the
 * cursor is not on a bar of the score.
 */
export function barPanelOf(json: ScoreJSON, { cursor: at, selection }: LocalPresence) {
  if (at === null) return null;
  const index = json.bars.findIndex((bar) => bar.id === at.barId);
  const bar = json.bars[index];
  if (bar === undefined) return null;
  const numberOf = (barId: string) => json.bars.findIndex((each) => each.id === barId) + 1;
  const ends = selection === null ? null : selection.kind === "beats" ? [selection.barId, selection.barId] : [selection.anchorBarId, selection.focusBarId];
  const numbers = ends?.map(numberOf);
  const range = numbers && numbers.every((number) => number > 0) ? { first: Math.min(...numbers), last: Math.max(...numbers) } : null;
  // A repeat set here starts on the first bar of the selection and ends on its last (docs/spec/commands.md, section 6).
  const repeatFirst = json.bars[(range?.first ?? index + 1) - 1];
  const repeatLast = json.bars[(range?.last ?? index + 1) - 1];
  return {
    bar: index + 1,
    range,
    timeSig: bar.timeSig,
    tempo: bar.tempo,
    tempoInForce: tempoAt(json, bar.id) ?? 0,
    keySig: bar.keySig,
    keySigInForce: keySigAt(json, bar.id) ?? DEFAULT_KEY_SIG,
    section: bar.section,
    repeatStart: repeatFirst?.repeatStart === true,
    repeatEnd: repeatLast?.repeatEnd,
    voltas: bar.voltas ?? [],
    // Voltas go on every bar of the selection, else on the cursor's.
    voltaRepeatTimes: voltaRepeatTimes(json, range ? json.bars.slice(range.first - 1, range.last).map((each) => each.id) : [bar.id]),
    firstBar: index === 0,
    anacrusis: bar.anacrusis === true,
  };
}
