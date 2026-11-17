// Drum pieces. In the score a percussion note is keyed "p<number>"; the number is alphaTab's
// percussion articulation id (the ids Guitar Pro 7 uses). For the pieces of a drum kit that id
// is also the General MIDI percussion key that sounds, except for the few playing styles that
// share a key with another piece (rim shot, half-open hi-hat, ride bell on the edge…), which
// have ids of their own above 90. The staff line and the note head come from alphaTab's table.
export interface DrumPiece {
  /** The number after "p" in the key of a note. */
  id: number;
  /** General MIDI percussion key that sounds. */
  midi: number;
  name: string;
}

/** The pieces the measurements and the tests use and check (S6); alphaTab knows about ninety more. */
export const DRUM_PIECES = {
  kick: { id: 36, midi: 36, name: "Kick" },
  snare: { id: 38, midi: 38, name: "Snare" },
  sideStick: { id: 37, midi: 37, name: "Snare side stick" },
  rimShot: { id: 91, midi: 38, name: "Snare rim shot" },
  hiHatClosed: { id: 42, midi: 42, name: "Hi-hat closed" },
  hiHatHalf: { id: 92, midi: 46, name: "Hi-hat half open" },
  hiHatOpen: { id: 46, midi: 46, name: "Hi-hat open" },
  hiHatPedal: { id: 44, midi: 44, name: "Hi-hat pedal" },
  tomHigh: { id: 48, midi: 48, name: "Tom high" },
  tomMid: { id: 47, midi: 47, name: "Tom mid" },
  tomLow: { id: 45, midi: 45, name: "Tom low" },
  tomFloor: { id: 43, midi: 43, name: "Tom floor" },
  crash: { id: 49, midi: 49, name: "Crash" },
  ride: { id: 51, midi: 51, name: "Ride" },
  rideBell: { id: 53, midi: 53, name: "Ride bell" },
  china: { id: 52, midi: 52, name: "China" },
  splash: { id: 55, midi: 55, name: "Splash" },
  cowbell: { id: 56, midi: 56, name: "Cowbell" },
} as const satisfies Record<string, DrumPiece>;
