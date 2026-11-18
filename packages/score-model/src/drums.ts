// The drum pieces the interface offers (docs/spec/schema.md, 7.1). In the score a percussion note
// is keyed "p<number>"; the number is alphaTab's percussion articulation id (the ids Guitar Pro 7
// uses), and the score allows any of them. For the pieces of a drum kit that id is also the
// General MIDI percussion key that sounds, except for the few playing styles that share a key with
// another piece (rim shot, half-open hi-hat…), which have ids of their own above 90. The staff
// position and the note head are alphaTab's (its built-in table); the position is kept here too,
// as data, so that the editor knows the line a piece is drawn on without the renderer.
export interface DrumPiece {
  /** The number after "p" in the key of a note. */
  id: number;
  /** General MIDI percussion key that sounds. */
  midi: number;
  name: string;
  /** Where alphaTab draws it: 0 is the top line of the staff, a step is half a staff space. */
  line: number;
}

/** The 18 pieces the keys enter (docs/spec/keymap.md, 4.2), checked against alphaTab in M0 (S6); alphaTab knows about ninety more. */
export const DRUM_PIECES = {
  kick: { id: 36, midi: 36, name: "Kick", line: 7 },
  snare: { id: 38, midi: 38, name: "Snare", line: 3 },
  sideStick: { id: 37, midi: 37, name: "Snare side stick", line: 3 },
  rimShot: { id: 91, midi: 38, name: "Snare rim shot", line: 3 },
  hiHatClosed: { id: 42, midi: 42, name: "Hi-hat closed", line: -1 },
  hiHatHalf: { id: 92, midi: 46, name: "Hi-hat half open", line: -1 },
  hiHatOpen: { id: 46, midi: 46, name: "Hi-hat open", line: -1 },
  hiHatPedal: { id: 44, midi: 44, name: "Hi-hat pedal", line: 9 },
  tomHigh: { id: 48, midi: 48, name: "Tom high", line: 2 },
  tomMid: { id: 47, midi: 47, name: "Tom mid", line: 4 },
  tomLow: { id: 45, midi: 45, name: "Tom low", line: 5 },
  tomFloor: { id: 43, midi: 43, name: "Tom floor", line: 6 },
  crash: { id: 49, midi: 49, name: "Crash", line: -2 },
  ride: { id: 51, midi: 51, name: "Ride", line: 0 },
  rideBell: { id: 53, midi: 53, name: "Ride bell", line: 0 },
  china: { id: 52, midi: 52, name: "China", line: -3 },
  splash: { id: 55, midi: 55, name: "Splash", line: -2 },
  cowbell: { id: 56, midi: 56, name: "Cowbell", line: 0 },
} as const satisfies Record<string, DrumPiece>;

export type DrumPieceName = keyof typeof DRUM_PIECES;

const LINES = new Map<number, number>(Object.values(DRUM_PIECES).map(({ id, line }) => [id, line]));
const LINES_BY_KEY = new Map<string, number>(Object.values(DRUM_PIECES).map(({ id, line }) => [`p${id}`, line]));

/**
 * The staff position a piece is drawn on, by its id; none for an id the interface does not offer,
 * which Delete's rule of the whole line leaves alone (docs/spec/schema.md, 7.1).
 */
export function drumLineOf(id: number): number | undefined {
  return LINES.get(id);
}

/** The staff position of the piece a note's key names ("p42"); none for any other key, a piece the interface does not offer among them. */
export function drumLineOfKey(key: string): number | undefined {
  return LINES_BY_KEY.get(key);
}
