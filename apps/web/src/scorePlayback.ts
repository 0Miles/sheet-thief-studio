// Playing a score on its page, and scrolling it (docs/spec/playback.md, section 4): what the
// toolbar's player shows, where playback is drawn, keeping it on screen while it is followed, and
// telling the page's own scrolls from the member's. The score's page (ScoreView) and the phrase
// editor (PhraseView) both play this way.
import { type PlayerState, playerUsable, type Rect, type ScoreEngine, type ScorePlayer } from "@studio/score-render";
import { type Ref, ref, shallowRef } from "vue";

import { clearOf, sameRect } from "./overlay";

export interface ScorePlaybackOptions {
  /** The element the score scrolls in. */
  scroller: Ref<HTMLElement | undefined>;
  /** The areas no overlay may cover, as of the last drawing. */
  reserved: () => readonly Rect[];
  /**
   * Where pressing play starts, unless playing goes on after a pause: the tick of the cursor's bar
   * (the edit views); null to play from where playback is (the Read view).
   */
  startTick: (player: ScorePlayer) => number | null;
  /**
   * The Read view: playback is followed whenever it plays, and always shown, at the start after a
   * stop (docs/spec/views.md, section 5).
   */
  reading: () => boolean;
  /**
   * The score is hidden (under the versions page, #68): playback, stopped as it is hidden, is never
   * followed there, whatever the view. Never hidden when left out.
   */
  hidden?: () => boolean;
}

/** Room left above playback when the page scrolls to it. */
const FOLLOW_MARGIN = 40;
/** Room left around the cursor when the page scrolls to it. */
const REVEAL_MARGIN = 80;

export function useScorePlayback({ scroller, reserved, startTick, reading, hidden = () => false }: ScorePlaybackOptions) {
  let engine: ScoreEngine | undefined;
  const playerState = ref<PlayerState>("loading");
  /**
   * Not playing and not paused: never started, stopped, or played to the end. Never in the Read
   * view, which always shows where playback is (where a click sent it, the start after a stop).
   */
  const stopped = ref(true);
  /** The bar playback is in, counted from 1, as the toolbar shows it; null while stopped. */
  const playingBar = ref<number | null>(null);
  /** Where playback is drawn, out of the reserved areas; null while stopped. */
  const playheadRect = shallowRef<Rect | null>(null);
  /** The member paused, and the cursor has not moved since: playing goes on from there. */
  let resumable = false;
  /** Playback is to be kept on screen: from pressing play until the member presses a key or scrolls. */
  let keepInSight = false;
  /** Where the page itself last scrolled the score to (`scrollTo`): a scroll anywhere else is the member's. */
  let ownScrollTop: number | null = null;

  /**
   * Playback is followed now: it plays and is kept on screen, so the page goes with it, not with
   * the cursor. The Read view follows it whenever it plays.
   */
  const isFollowing = () => !hidden() && (keepInSight || reading()) && playerState.value === "playing";

  /** Scroll the score, as the page: following playback, or showing the cursor. */
  function scrollTo(top: number): void {
    const element = scroller.value;
    if (element === undefined) return;
    element.scrollTop = top;
    // As far as it could go: at the end of the score, less than asked.
    ownScrollTop = element.scrollTop;
  }

  /** The member looks over the score themselves: playback is no longer kept on screen, until they press play. */
  function stopFollowing(): void {
    keepInSight = false;
  }

  /**
   * A scroll the page did not make is the member's, however they made it: the wheel, a touch, a
   * scroll bar (overlay scroll bars take no room, so a click on them cannot be told apart), keys.
   */
  function onScroll(): void {
    const element = scroller.value;
    if (element === undefined) return;
    if (ownScrollTop !== null) {
      if (Math.abs(element.scrollTop - ownScrollTop) < 1) return;
      // The score got shorter, or the view taller, than where the page had put it: the browser
      // brought it back as far as it goes. Not the member.
      if (element.scrollTop < ownScrollTop && element.scrollTop >= element.scrollHeight - element.clientHeight - 1) {
        ownScrollTop = element.scrollTop;
        return;
      }
    }
    stopFollowing();
  }

  /** Scroll so that this box (the cursor's) is on screen, with some room around it. */
  function reveal(box: Rect | null): void {
    const element = scroller.value;
    if (element === undefined || box === null) return;
    if (box.y < element.scrollTop + REVEAL_MARGIN) scrollTo(Math.max(box.y - REVEAL_MARGIN, 0));
    else if (box.y + box.height > element.scrollTop + element.clientHeight - REVEAL_MARGIN) scrollTo(box.y + box.height - element.clientHeight + REVEAL_MARGIN);
  }

  /** Show where playback is: the bar in the toolbar, the place on the page, kept on screen while following. */
  function showPlayback(tick: number): void {
    if (engine === undefined || stopped.value) return;
    const played = engine.player.barAt(tick);
    if (played !== null) playingBar.value = played.index + 1;
    const rect = engine.renderer.boundsAtTick(tick);
    const placed = rect && clearOf(rect, reserved());
    // Most positions fall on the beat drawn already: the page is not drawn again for them.
    if (!sameRect(placed, playheadRect.value)) playheadRect.value = placed;
    const element = scroller.value;
    if (!isFollowing() || rect === null || element === undefined) return;
    const top = element.scrollTop;
    if (rect.y >= top && rect.y + rect.height <= top + element.clientHeight) return;
    scrollTo(Math.max(rect.y - FOLLOW_MARGIN, 0));
  }

  /** Play from `startTick`; after the member paused, from where it was, unless the cursor moved since. */
  function play(): void {
    const player = engine?.player;
    if (player === undefined || player.state !== "paused") return;
    if (!resumable) {
      const tick = startTick(player);
      if (tick !== null) player.seek(tick);
    }
    resumable = false;
    stopped.value = false;
    keepInSight = true;
    player.play();
  }

  function pause(): void {
    if (engine?.player.state !== "playing") return;
    resumable = true;
    engine.player.pause();
  }

  /** Nothing plays any more: stopped, or at the end of the score, where the player is back at its start. */
  function showStopped(): void {
    resumable = false;
    // The Read view shows playback back at the start.
    if (reading()) return;
    stopped.value = true;
    playingBar.value = null;
    playheadRect.value = null;
  }

  function stop(): void {
    if (engine === undefined || !playerUsable(engine.player.state)) return;
    showStopped();
    engine.player.stop();
  }

  /** Ask again for the sound font that could not be had (docs/spec/playback.md, 4.1). */
  function retrySound(): void {
    engine?.player.retry();
  }

  function togglePlay(): void {
    if (playerState.value === "playing") pause();
    else play();
  }

  /** The cursor moved: playing starts from its bar again, not where it was paused. */
  function cursorMoved(): void {
    resumable = false;
  }

  /** The engine the page made: its player's state, position and end are shown from now on. */
  function attach(made: ScoreEngine): void {
    engine = made;
    // A browser that cannot play says so from the start, and never tells a change.
    playerState.value = made.player.state;
    made.player.onState((state) => {
      playerState.value = state;
      // Once the first sound is in, the Read view can show where playback is.
      showPlayback(made.player.position.tick);
    });
    made.player.onFinished(showStopped);
    made.player.onPosition((position) => showPlayback(position.tick));
  }

  return {
    playerState,
    stopped,
    playingBar,
    playheadRect,
    isFollowing,
    attach,
    showPlayback,
    play,
    pause,
    stop,
    retrySound,
    togglePlay,
    cursorMoved,
    stopFollowing,
    scrollTo,
    onScroll,
    reveal,
  };
}
