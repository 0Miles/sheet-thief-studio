// The recognizer's contract (docs/spec/recognizer.md, section 5): the shared fixtures pass both the
// JSON Schema the Python service is held to and the zod shape the server reads it with, and a
// broken copy of them fails both.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";

import { RECOGNIZER_CONTRACT, RECOGNIZER_CONTRACT_VERSION, type RecognizerFailure, recognizerFailure, recognizerResponse, type RecognizerResult, recognizerResult } from "../src/index";

const CONTRACT = new URL("../../../services/recognizer/contract/", import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(path, CONTRACT)), "utf8"));

// Strict, so that a misspelt keyword fails; the conditions on the number of strings name no types,
// which only Ajv's strictTypes asks for.
const schema = read("recognition.schema.json") as Json;
const jsonSchema = new Ajv2020({ strict: true, strictTypes: false, allErrors: true }).compile(schema);

/** The fixtures by name (the file name without `.json`). */
const fixtures = new Map(
  readdirSync(fileURLToPath(new URL("fixtures/", CONTRACT)))
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file.slice(0, -".json".length), read(`fixtures/${file}`)]),
);

test.each([...fixtures])("the fixture %s passes the JSON Schema and zod", (_, fixture) => {
  expect(jsonSchema(fixture), JSON.stringify(jsonSchema.errors)).toBe(true);
  expect(recognizerResponse.safeParse(fixture).error).toBeUndefined();
});

test("the fixtures hold the cases the contract names: six, four and seven strings, a capo, an unreadable tuning, grace notes and strokes, and errors", () => {
  const results = [...fixtures.values()].filter((fixture) => recognizerResult.safeParse(fixture).success) as RecognizerResult[];
  const failures = [...fixtures.values()].filter((fixture) => recognizerFailure.safeParse(fixture).success) as RecognizerFailure[];
  const notes = (result: RecognizerResult) => result.bars.flatMap((bar) => bar.beats.flatMap((beat) => beat.notes));

  expect(results.length).toBeGreaterThanOrEqual(6);
  expect(failures.length).toBeGreaterThanOrEqual(3);
  expect(new Set(results.map((result) => result.strings))).toEqual(new Set([4, 6, 7]));
  expect(results.some((result) => result.capo.source === "detected" && result.capo.fret > 0)).toBe(true);
  expect(results.some((result) => result.tuning.reason === "unrecognized")).toBe(true);
  expect(results.some((result) => notes(result).some((note) => note.graceFret !== null))).toBe(true);
  expect(results.some((result) => notes(result).some((note) => note.stroke !== null) && notes(result).some((note) => note.velocity !== null))).toBe(true);
  expect(new Set(failures.map((failure) => failure.error.code))).toEqual(new Set(["recognition_failed", "timeout", "unavailable", "busy"]));
  expect(new Set(failures.flatMap((failure) => failure.error.pages.map((page) => page.code)))).toEqual(new Set(["no_staff", "no_notes", "invalid_image", "image_too_large"]));
});

// As the predecessor warns (converter.py, _flag_estimated_rhythm): only when another bar of the
// part read its printed rhythm, and naming every bar estimated from the spacing.
test.each([...fixtures].filter(([, fixture]) => recognizerResult.safeParse(fixture).success))("the fixture %s warns of estimated rhythm as the recognizer would", (_, fixture) => {
  const result = fixture as RecognizerResult;
  const estimated = result.bars.flatMap((bar, index) => (bar.rhythmEstimated ? [index + 1] : []));
  const warned = result.warnings.flatMap((warning) => (warning.code === "rhythm_estimated" ? [warning.params.bars] : []));
  expect(warned).toEqual(estimated.length > 0 && estimated.length < result.bars.length ? [estimated] : []);
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A copy of a fixture, broken by `change`. */
function broken(name: string, change: (json: Json) => void): unknown {
  const json = structuredClone(fixtures.get(name)) as Json;
  change(json);
  return json;
}
const firstNote = (json: Json): Json => json.bars[0].beats[0].notes[0];

test.each<[string, string, (json: Json) => void]>([
  ["another version", "six-strings", (json) => (json.version = 2)],
  ["another contract", "six-strings", (json) => (json.contract = "sheet-thief/recognition")],
  ["no version", "error-busy", (json) => delete json.version],
  ["three strings", "four-strings", (json) => (json.strings = 3)],
  ["eight strings", "seven-strings", (json) => (json.strings = 8)],
  ["a tuning with a pitch too few", "six-strings", (json) => json.tuning.midi.pop()],
  ["a tuning with a pitch too many", "four-strings", (json) => json.tuning.midi.push(23)],
  ["a note on a string the TAB does not have", "four-strings", (json) => (firstNote(json).string = 5)],
  ["a note on string 7 of a six-string TAB", "six-strings", (json) => (firstNote(json).string = 7)],
  ["two notes on one string", "six-strings", (json) => (json.bars[0].beats[0].notes[1].string = 6)],
  ["a detected tuning with a reason", "six-strings", (json) => (json.tuning.reason = "unrecognized")],
  ["an unreadable tuning without its text", "tuning-unrecognized", (json) => (json.tuning.raw = null)],
  ["a tuning from somewhere else", "six-strings", (json) => (json.tuning.source = "manual")],
  ["a default capo on a fret", "six-strings", (json) => (json.capo.fret = 2)],
  ["a capo past fret 24", "capo", (json) => (json.capo.fret = 25)],
  ["a time signature over 3", "six-strings", (json) => (json.timeSignature.denominator = 3)],
  ["a song in 17/4", "six-strings", (json) => (json.timeSignature.numerator = 17)],
  ["a song in 4/32", "six-strings", (json) => (json.timeSignature.denominator = 32)],
  ["a bar in 33/8", "four-strings", (json) => (json.bars[1].timeSignature = { numerator: 33, denominator: 8 })],
  ["a tempo past 400", "six-strings", (json) => (json.bars[0].tempo = 401)],
  ["a tempo in fractions of a beat", "six-strings", (json) => (json.bars[0].tempo = 96.5)],
  ["a repeat played 33 times", "six-strings", (json) => (json.bars[1].repeatTimes = 33)],
  ["a volta numbered 10", "seven-strings", (json) => (json.bars[1].endings = [10])],
  ["a volta pass twice", "seven-strings", (json) => (json.bars[1].endings = [1, 1])],
  ["an empty section name", "six-strings", (json) => (json.bars[0].marker = "")],
  ["no bars", "six-strings", (json) => (json.bars = [])],
  ["a bar with no beats", "six-strings", (json) => (json.bars[0].beats = [])],
  ["a length no note value has", "six-strings", (json) => (json.bars[0].beats[0].units = 5)],
  ["a length longer than a dotted whole note", "six-strings", (json) => (json.bars[0].beats[0].units = 64)],
  ["a repeat played once", "six-strings", (json) => (json.bars[1].repeatTimes = 1)],
  ["a sign by its printed name", "seven-strings", (json) => (json.bars[0].sign = "Segno")],
  ["a fret past 29", "six-strings", (json) => (firstNote(json).fret = 30)],
  ["a dead note with a fret", "six-strings", (json) => Object.assign(firstNote(json), { dead: true })],
  ["a note with no fret", "six-strings", (json) => (firstNote(json).fret = null)],
  ["a grace hammer with no grace note", "six-strings", (json) => (firstNote(json).graceHammer = true)],
  ["a velocity past 127", "grace-and-strokes", (json) => (firstNote(json).velocity = 128)],
  ["a stroke in no direction", "grace-and-strokes", (json) => (firstNote(json).stroke = "across")],
  ["an unresolved link", "six-strings", (json) => (firstNote(json).link = "h")],
  ["a note missing a field", "six-strings", (json) => delete firstNote(json).palmMute],
  ["a warning in words", "six-strings", (json) => json.warnings.push({ code: "other", params: {}, message: "Ritmo estimado" })],
  ["a warning with no code", "six-strings", (json) => json.warnings.push({ code: "rhythm_guessed", params: {} })],
  ["a warning missing its parameters", "six-strings", (json) => (json.warnings[0].params = {})],
  ["an error with a message", "error-timeout", (json) => (json.error.message = "Tempo esgotado")],
  ["an error code from another layer", "error-busy", (json) => (json.error.code = "no_staff")],
  ["pages on an error that is not about them", "error-busy", (json) => json.error.pages.push({ page: 1, code: "no_notes" })],
  ["a page counted from 0", "error-pages", (json) => (json.error.pages[0].page = 0)],
  ["a result that is also an error", "six-strings", (json) => (json.error = { code: "busy", params: {}, pages: [] })],
])("a fixture broken by %s fails both the JSON Schema and zod", (_, name, change) => {
  const json = broken(name, change);
  expect(jsonSchema(json)).toBe(false);
  expect(recognizerResponse.safeParse(json).success).toBe(false);
});

test("the JSON Schema carries its version, and a sentence for every field", () => {
  expect(schema.$id).toBe(`urn:sheet-thief-studio:recognition:${RECOGNIZER_CONTRACT_VERSION}`);
  expect(schema.$defs.version.const).toBe(RECOGNIZER_CONTRACT_VERSION);
  expect(schema.$defs.contract.const).toBe(RECOGNIZER_CONTRACT);

  const described = (field: Json) => typeof (field.$ref ? schema.$defs[field.$ref.slice("#/$defs/".length)] : field).description === "string" || typeof field.description === "string";
  const silent: string[] = [];
  (function visit(node: unknown, path: string) {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${path}/${index}`));
    if (typeof node !== "object" || node === null) return;
    // Every object of the contract is closed (additionalProperties: false), so a closed schema is
    // where fields are defined; the conditions (if/then, contains, the string-count narrowings) are not.
    const { additionalProperties, properties } = node as Json;
    if (additionalProperties === false) for (const [name, field] of Object.entries(properties ?? {})) if (!described(field as Json)) silent.push(`${path}/properties/${name}`);
    for (const [key, value] of Object.entries(node)) visit(value, `${path}/${key}`);
  })(schema, "#");
  expect(silent).toEqual([]);
});
