// Typing on a keyboard's two staves and on a voice's one in the edit view (#49; docs/spec/keymap.md,
// sections 3 and 4.3): letters enter notes, Ctrl+↓ goes on to the bass staff, Alt+2 to the second
// voice, Shift+L ties; a clef changed keeps the notes' pitches. Every key goes through the real
// keyboard; the page is read through `window.__studioTest` and the DOM only.
import { expect, test } from "./test";
import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { cursorOf, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

/** The notes of each beat of a voice of a part, in the first bar. */
async function notesIn(page: Parameters<typeof scoreOf>[0], part: number, voice: string) {
  const score = await scoreOf(page);
  return (score.parts[part]!.content[score.bars[0]!.id]?.[voice] ?? []).map((beat) => beat.notes);
}

test("on a keyboard, C, D, E on the treble staff, Ctrl+↓, F on the bass staff: 0:0 and 1:0 hold them; Shift+L ties the F on; after reloading the score holds them", async ({ browser }) => {
  const id = seedScore({
    title: "鍵盤的打譜",
    owner: ADMIN.username,
    members: [{ username: EDITOR.username, role: "editor" }],
    bars: 4,
    parts: [{ name: "鍵盤 1", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] }],
  });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const keyboard = (await scoreOf(page)).parts[1]!.id;
  await page.keyboard.press("Control+ArrowDown");
  expect(await cursorOf(page)).toMatchObject({ partId: keyboard, voice: "0:0", beatId: null, at: "after" });

  // From the treble staff's middle line, B4: C5, D5, E5.
  for (const key of ["c", "ArrowRight", "d", "ArrowRight", "e"]) await page.keyboard.press(key);
  await page.keyboard.press("Control+ArrowDown");
  expect(await cursorOf(page)).toMatchObject({ partId: keyboard, voice: "1:0", beatId: null, at: "after" });
  // From the bass staff's middle line, D3: F3.
  await page.keyboard.press("f");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+L");
  const expected = {
    "0:0": [{ n72: { spell: "C" } }, { n74: { spell: "D" } }, { n76: { spell: "E" } }],
    "1:0": [{ n53: { spell: "F" } }, { n53: { spell: "F", tie: true } }],
  };
  const both = async () => ({ "0:0": await notesIn(page, 1, "0:0"), "1:0": await notesIn(page, 1, "1:0") });
  expect(await both()).toEqual(expected);
  await drawn(page);
  await expect(page.locator("[data-cursor]")).toBeVisible();
  // The tie goes on from the F before it: no flag.
  await expect(page.locator('[data-flag][data-kind="danglingTie"]')).toHaveCount(0);
  await synced(page);

  await page.reload();
  await drawn(page);
  expect(await both()).toEqual(expected);
  expect(errors).toEqual([]);
});

test("on a voice, Alt+2 then A writes the note in 0:1; with the clef changed to treble-8vb the notes keep their keys", async ({ browser }) => {
  const id = seedScore({ title: "人聲的打譜", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4, parts: [{ name: "人聲 1", kind: "pitched" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const voice = (await scoreOf(page)).parts[1]!.id;
  await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("c");
  await page.keyboard.press("Alt+2");
  expect(await cursorOf(page)).toMatchObject({ partId: voice, voice: "0:1" });
  // From the middle line, B4: A4.
  await page.keyboard.press("a");
  const expected = { "0:0": [{ n72: { spell: "C" } }], "0:1": [{ n69: { spell: "A" } }] };
  const both = async () => ({ "0:0": await notesIn(page, 1, "0:0"), "0:1": await notesIn(page, 1, "0:1") });
  expect(await both()).toEqual(expected);
  await synced(page);

  // The clef, from the panel of the parts: drawn an octave over, sounding where it did.
  await page.locator("[data-toggle-parts]").click();
  const panel = page.locator("[data-part-panel]");
  await panel.locator(`[data-part-row][data-part-id="${voice}"] [data-part-edit]`).click();
  const clef = panel.locator("[data-part-properties] [data-part-clef]");
  await clef.getByLabel(strings.score.parts.clef(1)).selectOption("treble-8vb");
  await clef.getByRole("button", { name: strings.score.parts.apply }).click();
  await expect.poll(async () => (await scoreOf(page)).parts[1]!.staves).toEqual([{ clef: "treble-8vb" }]);
  await drawn(page);
  expect(await both()).toEqual(expected);

  await page.reload();
  await drawn(page);
  expect(await both()).toEqual(expected);
  expect((await scoreOf(page)).parts[1]!.staves).toEqual([{ clef: "treble-8vb" }]);
  expect(errors).toEqual([]);
});
