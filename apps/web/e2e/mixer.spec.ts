// The mixer (#33; docs/spec/playback.md, sections 1, 3 and 4): each member's own settings, kept in
// this browser; the selection played as a loop; the metronome and the count-in; and changes made
// while the score plays. How it sounds is for a person to judge (#41): here the settings, the
// positions and the states are checked.
import { expect, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { barsShown, loggedIn, oneAfterAnother, openToPlay, pageErrors, recordBarsShown, scoreOf, seedScore, untilShown } from "./pages";

const text = strings.score;

/** A score of a guitar and a bass, the Editor a member of it. */
function seed(bars?: number): string {
  return seedScore({ title: "混音測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars, parts: [{ name: "貝斯", kind: "fretted" }] });
}

/** The settings the player plays with, as it holds them. */
function playerSettings(page: Page) {
  return page.evaluate(() => window.__studioTest!.player());
}

/** The mixer at the side of the score, opened from the toolbar. */
async function openMixer(page: Page) {
  await page.locator("[data-toggle-mixer]").click();
  const mixer = page.locator("[data-mixer-panel]");
  await expect(mixer).toBeVisible();
  return mixer;
}

test("every setting is kept after a reload; the mix and the speed for this score only, the others for every score", async ({ browser }) => {
  const id = seed();
  const other = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const [guitar, bass] = (await scoreOf(page)).parts;
  let mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.muteOf(bass!.name)).check();
  await mixer.getByLabel(text.mixer.soloOf(guitar!.name)).check();
  await mixer.getByLabel(text.mixer.volumeOf(guitar!.name)).fill("0.5");
  await mixer.getByLabel(text.mixer.speed).selectOption({ label: text.mixer.percent(0.75) });
  await mixer.getByLabel(text.mixer.metronome).check();
  await mixer.getByLabel(text.mixer.countIn).check();
  await mixer.getByLabel(text.mixer.whilePlaying).selectOption({ label: text.mixer.modes.b });

  // Opened again: the page loads anew.
  await openToPlay(page, id);
  mixer = await openMixer(page);
  await expect(mixer.getByLabel(text.mixer.muteOf(bass!.name))).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.muteOf(guitar!.name))).not.toBeChecked();
  await expect(mixer.getByLabel(text.mixer.soloOf(guitar!.name))).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.volumeOf(guitar!.name))).toHaveValue("0.5");
  await expect(mixer.getByLabel(text.mixer.volumeOf(bass!.name))).toHaveValue("1");
  await expect(mixer.getByLabel(text.mixer.speed)).toHaveValue("0.75");
  await expect(mixer.getByLabel(text.mixer.metronome)).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.countIn)).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.whilePlaying)).toHaveValue("b");
  // And the player plays with them, not only the panel showing them.
  expect(await playerSettings(page)).toEqual({
    speed: 0.75,
    metronome: true,
    countIn: true,
    loop: null,
    parts: { [guitar!.id]: { mute: false, solo: true, volume: 0.5 }, [bass!.id]: { mute: true, solo: false, volume: 1 } },
  });

  // Another score: its own mix, as the score has it; the same metronome, count-in and behaviour.
  await openToPlay(page, other);
  const [otherGuitar, otherBass] = (await scoreOf(page)).parts;
  mixer = await openMixer(page);
  await expect(mixer.getByLabel(text.mixer.muteOf(otherBass!.name))).not.toBeChecked();
  await expect(mixer.getByLabel(text.mixer.soloOf(otherGuitar!.name))).not.toBeChecked();
  await expect(mixer.getByLabel(text.mixer.volumeOf(otherGuitar!.name))).toHaveValue("1");
  await expect(mixer.getByLabel(text.mixer.speed)).toHaveValue("1");
  await expect(mixer.getByLabel(text.mixer.metronome)).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.whilePlaying)).toHaveValue("b");
  expect(await playerSettings(page)).toEqual({ speed: 1, metronome: true, countIn: true, loop: null, parts: {} });
  expect(errors).toEqual([]);
});

test("with bars 2-3 selected, playback at the end of bar 3 goes back to bar 2", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+Shift+ArrowRight");
  const mixer = await openMixer(page);
  await expect(mixer.locator("[data-loop]")).toContainText(text.mixer.loopBars(2, 3));
  // From the start of bar 2 to the end of bar 3: 960 ticks to a quarter note, 4/4.
  expect((await playerSettings(page))!.loop).toEqual({ startTick: 3840, endTick: 3 * 3840 });
  await mixer.getByRole("button", { name: text.mixer.close }).click();

  await recordBarsShown(page);
  await page.getByRole("button", { name: text.player.play }).click();
  await expect.poll(() => barsShown(page), { timeout: 20_000 }).toEqual([3, 2, 3]);
  await page.getByRole("button", { name: text.player.pause }).click();
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  expect(await barsShown(page)).not.toContain(4);

  // No selection, no loop: playback goes on past bar 3.
  await page.keyboard.press("ArrowLeft");
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 4);
  expect(errors).toEqual([]);
});

test("with the metronome and the count-in on, the score plays, with no error", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.metronome).check();
  await mixer.getByLabel(text.mixer.countIn).check();
  await page.getByRole("button", { name: text.player.play }).click();
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  // A bar of count-in first, then the score.
  await expect(page.locator("[data-playing-bar]")).toHaveAttribute("data-bar", "2", { timeout: 15_000 });
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("(b): a change while it plays is not heard yet, and the page says so; once paused, it is, and the notice goes", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.whilePlaying).selectOption({ label: text.mixer.modes.b });
  await mixer.getByRole("button", { name: text.mixer.close }).click();

  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 2);
  await page.keyboard.press("5");
  await expect(page.locator("[data-behind]")).toHaveText(text.mixer.behind);
  await untilShown(page, 3);
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  await expect(page.locator("[data-behind]")).toBeVisible();
  expect(oneAfterAnother(await barsShown(page))).toBe(true);

  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  await expect(page.locator("[data-behind]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a tempo and a repeat set while it plays: playback goes on in the bar it was in, never back", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 3);

  // The panel of the cursor's bar, the first: a tempo, then bar 1 played twice.
  await page.keyboard.press("F2");
  const panel = page.locator("[data-bar-panel]");
  await panel.locator('input[name="tempo"]').fill("150");
  await panel.locator('input[name="tempo"]').press("Enter");
  await expect.poll(async () => (await scoreOf(page)).bars[0]!.tempo).toBe(150);
  const repeat = panel.locator("[data-panel-repeat]");
  await repeat.locator('input[name="repeatTimes"]').fill("2");
  await repeat.locator('input[name="repeatTimes"]').press("Enter");
  await expect.poll(async () => (await scoreOf(page)).bars[0]!.repeatEnd).toBe(2);

  const after = (await barsShown(page)).at(-1)!;
  await untilShown(page, after + 2);
  const shown = await barsShown(page);
  expect(oneAfterAnother(shown), shown.join(", ")).toBe(true);
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  expect(errors).toEqual([]);
});

/**
 * What the page told the synthesizer's worker and what it heard from it, in the order it happened:
 * each new sound sent, each channel's volume sent, and the worker saying the sound is loaded and
 * that it is ready to play.
 */
type SynthMessage = { cmd: "loadMidi" } | { cmd: "volume"; channel: number; volume: number } | { cmd: "midiLoaded" } | { cmd: "readyForPlayback" };

/** Keep, from the next page load on, what the page sends to alphaTab's synthesizer worker and hears from it. */
async function recordSynthMessages(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    const record: unknown[] = [];
    (window as unknown as { __synthMessages: unknown[] }).__synthMessages = record;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const message = args[0] as { cmd?: string; channel?: number; volume?: number } | null;
      if (message?.cmd === "alphaSynth.loadMidi") record.push({ cmd: "loadMidi" });
      if (message?.cmd === "alphaSynth.setChannelVolume") record.push({ cmd: "volume", channel: message.channel, volume: message.volume });
      return (post as (...all: unknown[]) => void).apply(this, args);
    } as typeof post;
    // Heard by a listener added as the worker is made, before alphaTab adds its own: what the
    // worker says is in the record before anything the page sends in answer to it.
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          const cmd = (event.data as { cmd?: string } | null)?.cmd;
          if (cmd === "alphaSynth.midiLoaded") record.push({ cmd: "midiLoaded" });
          if (cmd === "alphaSynth.readyForPlayback") record.push({ cmd: "readyForPlayback" });
        });
      }
    };
  });
}

function synthMessages(page: Page): Promise<SynthMessage[]> {
  return page.evaluate(() => (window as unknown as { __synthMessages: SynthMessage[] }).__synthMessages);
}

/** The volume each channel was given last. */
function lastVolumes(messages: SynthMessage[]): Record<number, number> {
  const volumes: Record<number, number> = {};
  for (const message of messages) if (message.cmd === "volume") volumes[message.channel] = message.volume;
  return volumes;
}

/** Whether the worker has said, after the last new sound sent to it, that it is loaded and, after that, that it is ready to play. */
function lastSoundIsReady(messages: SynthMessage[]): boolean {
  const heard = messages.map((message) => message.cmd);
  const loaded = heard.indexOf("midiLoaded", heard.lastIndexOf("loadMidi") + 1);
  return loaded !== -1 && heard.includes("readyForPlayback", loaded + 1);
}

test("opened again, the volume a member gave a part is the last one the synthesizer is told: alphaTab's own does not win (#152)", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const [guitar] = (await scoreOf(page)).parts;
  const mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.volumeOf(guitar!.name)).fill("0.5");

  await recordSynthMessages(page);
  await openToPlay(page, id);
  // The worker says the last new sound is loaded, then that it is ready to play once more; each
  // time it is ready alphaTab sets every channel to the volume written in the score, 15/16
  // (docs/spec/playback.md, section 5, #152). Between the two the member's volumes are the last
  // ones sent whatever the engine does when the player is ready, so the volumes are read from a
  // record that has that last "ready" in it, the very one it was found in (#199). alphaTab and
  // the engine answer the worker within the event that brings its message: a record with the
  // message in it has their answers too.
  let volumes: Record<number, number> | null = null;
  await expect
    .poll(
      async () => {
        const messages = await synthMessages(page);
        volumes = lastSoundIsReady(messages) ? lastVolumes(messages) : null;
        return volumes !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // The guitar on channels 0 and 2, the bass, never set, on 1 and 3.
  expect(volumes).toEqual({ 0: 0.5, 1: 1, 2: 0.5, 3: 1 });
  expect(errors).toEqual([]);
});
