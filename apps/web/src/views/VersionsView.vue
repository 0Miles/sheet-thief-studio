<script setup lang="ts">
// A score's versions (`/scores/:id/versions`; docs/spec/collab.md, section 8; docs/spec/routes.md,
// 3.6): every member, a Viewer too, lists them and previews one, drawn and played read-only as the
// Read view draws a score; the preview never connects to /collab and changes nothing. An Owner or
// an Editor names a version (a named one is never deleted on its own), saves what the score is now
// as a named version, and restores one: a page of the score's (ScorePage), which holds the score
// open under it, the version is written in that document once the server made a version of what
// the score is now (restore.ts), and the member is back on the score, where Ctrl+Z undoes it
// (docs/spec/collab.md, 8.5). Anyone who is not a member sees the 404 page.
import { AppButton, AppConfirmDialog, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { createdVersion, type ScoreDetails, scoreDetails, scoreSchema, versionLimits, versionList, type VersionSummary, versionSummary } from "@studio/contracts";
import { keyNameOf } from "@studio/score-editor";
import type { ScoreJSON } from "@studio/score-model";
import { createAlphaTabEngine, type PlayerState, type ScoreEngine } from "@studio/score-render";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiError, get, patchFor, postFor, refusal } from "../api";
import AppHeader from "../components/AppHeader.vue";
import PlayerControls from "../components/PlayerControls.vue";
import { keyPlatform } from "../device";
import { type RestoreTarget, restoreVersion } from "../restore";
import { strings } from "../strings";
import { exposeForTests } from "../testHook";
import NotFoundView from "./NotFoundView.vue";

/** The score open under this page, which a version is restored in. */
const props = defineProps<{ id: string; restoreTarget: RestoreTarget }>();
const router = useRouter();
const text = strings.versions;
const path = `/api/scores/${props.id}/versions`;
const MAX_NAME = versionLimits.name.max;
/** The key that undoes a restore, back on the score. */
const undoKey = keyNameOf("undo", keyPlatform());

const details = ref<ScoreDetails | null>(null);
const notFound = ref(false);
/** What to say when something could not be done; null while all is well. */
const error = ref<string | null>(null);
/** The versions, the latest first; null until known. */
const versions = ref<VersionSummary[] | null>(null);
/** An Owner or an Editor: they name versions and save new ones (docs/spec/routes.md, 3.6). */
const canWrite = computed(() => details.value !== null && details.value.role !== "viewer");

const when = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "medium" });
const timeOf = (version: VersionSummary) => when.format(new Date(version.createdAt));

// The version being named, and the name typed for it.
const naming = ref<string | null>(null);
const nameDraft = ref("");
// The name of a version to save now.
const newName = ref("");
const sending = ref(false);

// The preview: the version chosen, its content once it came, and the score drawn of it.
const selected = ref<string | null>(null);
const previewed = shallowRef<ScoreJSON | null>(null);
const previewError = ref<string | null>(null);
/** The version chosen is drawn: e2e tests wait for `data-ready` (docs/spec/testing.md, section 2). */
const drawnVersion = ref<string | null>(null);
const host = ref<HTMLElement>();
let engine: ScoreEngine | undefined;
/** The version last handed to the renderer: drawn once it reports so. */
let drawing: string | null = null;
const playerState = ref<PlayerState>("loading");
/** Nothing to stop: never started, or stopped. */
const stopped = ref(true);
const playingBar = ref<number | null>(null);
/** Counts the previews asked for: an answer that comes after a newer one was asked for is dropped. */
let previewing = 0;

/** The version the member asked to restore, while the question is asked. */
const restoring = ref<VersionSummary | null>(null);

const selectedVersion = computed(() => versions.value?.find((version) => version.id === selected.value) ?? null);

const hideFromTests = exposeForTests({
  scoreJson: () => previewed.value,
  cursor: () => null,
  flags: () => [],
  player: () => engine?.player.settings() ?? null,
});

async function loadList(): Promise<void> {
  versions.value = (await get(path, versionList)).versions;
}

onMounted(async () => {
  try {
    details.value = await get(`/api/scores/${props.id}`, scoreDetails);
    await loadList();
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) {
      notFound.value = true;
      return;
    }
    error.value = refusal(failure);
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
  await nextTick();
  if (host.value === undefined) return;
  // As the Read view draws a score: in a worker, a click sending playback there.
  engine = createAlphaTabEngine(host.value, { fontDirectory: "/font/", soundFont: "/soundfont/sonivox.sf3", useWorkers: true, seekOnClick: true });
  engine.renderer.onRendered(() => {
    drawnVersion.value = drawing;
  });
  engine.player.onState((state) => {
    playerState.value = state;
  });
  engine.player.onPosition((position) => {
    if (stopped.value || engine === undefined) return;
    const played = engine.player.barAt(position.tick);
    if (played !== null) playingBar.value = played.index + 1;
  });
  engine.player.onFinished(showStopped);
});

onBeforeUnmount(() => {
  hideFromTests();
  engine?.destroy();
});

/** Draw the version: its content as the server brings it to the current schema. */
async function preview(version: VersionSummary): Promise<void> {
  const asked = ++previewing;
  selected.value = version.id;
  previewError.value = null;
  stop();
  try {
    const score = await get(`${path}/${version.id}`, scoreSchema);
    if (asked !== previewing) return;
    previewed.value = score;
    drawnVersion.value = null;
    drawing = version.id;
    engine?.renderer.setScore(score);
  } catch (failure) {
    if (asked !== previewing) return;
    previewed.value = null;
    previewError.value = refusal(failure);
  }
}

function showStopped(): void {
  stopped.value = true;
  playingBar.value = null;
}

function stop(): void {
  if (engine === undefined || engine.player.state === "loading") return;
  showStopped();
  engine.player.stop();
}

function togglePlay(): void {
  const player = engine?.player;
  if (player === undefined) return;
  if (player.state === "playing") {
    player.pause();
  } else if (player.state === "paused") {
    stopped.value = false;
    player.play();
  }
}

function startNaming(version: VersionSummary): void {
  naming.value = version.id;
  nameDraft.value = version.name ?? "";
}

/** Name the version, or take its name away when the field is left empty. */
async function saveName(version: VersionSummary): Promise<void> {
  error.value = null;
  sending.value = true;
  try {
    const trimmed = nameDraft.value.trim();
    const named = await patchFor(`${path}/${version.id}`, { name: trimmed === "" ? null : trimmed }, versionSummary);
    versions.value = versions.value?.map((item) => (item.id === named.id ? named : item)) ?? null;
    naming.value = null;
  } catch (failure) {
    error.value = refusal(failure);
  } finally {
    sending.value = false;
  }
}

/**
 * Restore the version, the question answered: a version of what the score is now first, then the
 * version written over the score this tab has open, and the member back on it. Nothing is
 * restored when the server could not make that version first.
 */
async function restore(): Promise<void> {
  const version = restoring.value;
  restoring.value = null;
  if (version === null) return;
  error.value = null;
  sending.value = true;
  try {
    const result = await restoreVersion(props.id, version.id, props.restoreTarget);
    if (result === "restored") {
      await router.push({ name: "score", params: { id: props.id } });
      return;
    }
    error.value = text.restore[result];
    // The version made before, if any, is in the list now.
    if (result === "notWritten") await loadList();
  } catch (failure) {
    error.value = refusal(failure);
  } finally {
    sending.value = false;
  }
}

/** Save what the score is now on the server as a version with this name; it heads the list. */
async function saveNow(): Promise<void> {
  error.value = null;
  sending.value = true;
  try {
    await postFor(path, { name: newName.value.trim() }, createdVersion);
    newName.value = "";
    await loadList();
  } catch (failure) {
    error.value = refusal(failure);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <main class="versions">
      <Stack gap="5">
        <Stack gap="1">
          <RouterLink :to="{ name: 'score', params: { id } }">{{ text.back }}</RouterLink>
          <h1>{{ text.title }}<span v-if="details" class="versions__score">{{ details.title || strings.score.untitled }}</span></h1>
          <p class="versions__muted">{{ text.help }}</p>
        </Stack>
        <p v-if="error" class="versions__error" role="alert">{{ error }}</p>
        <p v-if="versions === null && error === null" class="versions__muted">{{ strings.loading }}</p>
        <form v-if="canWrite" class="versions__save" novalidate data-save-version @submit.prevent="saveNow">
          <Stack gap="2">
            <h2>{{ text.save.title }}</h2>
            <p class="versions__muted">{{ text.save.help }}</p>
            <Cluster gap="2" align="end">
              <AppTextField v-model="newName" :label="text.name" name="version-name" :maxlength="MAX_NAME" autocomplete="off" required />
              <AppButton type="submit" variant="primary" :loading="sending" :disabled="newName.trim() === ''">{{ text.save.submit }}</AppButton>
            </Cluster>
          </Stack>
        </form>
        <div v-if="versions" class="versions__body">
          <section class="versions__list" :aria-label="text.list">
            <p v-if="versions.length === 0" class="versions__muted">{{ text.empty }}</p>
            <ul v-else>
              <li
                v-for="version in versions"
                :key="version.id"
                class="versions__item"
                :class="{ 'versions__item--selected': version.id === selected }"
                data-version
                :data-version-id="version.id"
                :data-reason="version.reason"
                :data-named="version.name !== null"
              >
                <div class="versions__line">
                  <time :datetime="version.createdAt" class="versions__time">{{ timeOf(version) }}</time>
                  <span class="versions__muted">{{ text.reasons[version.reason] }}</span>
                  <span class="versions__muted">{{ text.size(version.byteSize) }}</span>
                </div>
                <div v-if="version.name !== null" class="versions__name" data-version-name>
                  <span class="versions__tag">{{ text.named }}</span>
                  {{ version.name }}
                </div>
                <form v-if="naming === version.id" class="versions__naming" novalidate data-naming @submit.prevent="saveName(version)">
                  <Stack gap="2">
                    <AppTextField v-model="nameDraft" :label="text.renameOf(timeOf(version))" name="version-rename" :maxlength="MAX_NAME" autocomplete="off" full-width />
                    <!-- A member's own version keeps a name (docs/spec/collab.md, 8.4). -->
                    <p class="versions__muted">{{ version.reason === "manual" ? text.nameRuleManual : text.nameRule }}</p>
                    <Cluster gap="2">
                      <AppButton type="submit" variant="primary" size="sm" :loading="sending" :disabled="version.reason === 'manual' && nameDraft.trim() === ''">{{ text.saveName }}</AppButton>
                      <AppButton variant="ghost" size="sm" @click="naming = null">{{ text.cancel }}</AppButton>
                    </Cluster>
                  </Stack>
                </form>
                <Cluster v-else gap="2">
                  <AppButton variant="ghost" size="sm" data-preview @click="preview(version)">{{ text.preview }}</AppButton>
                  <AppButton v-if="canWrite" variant="ghost" size="sm" data-rename @click="startNaming(version)">{{ text.rename }}</AppButton>
                  <AppButton v-if="canWrite" variant="ghost" size="sm" data-restore :disabled="sending" @click="restoring = version">{{ text.restore.action }}</AppButton>
                </Cluster>
              </li>
            </ul>
          </section>
          <section class="versions__preview" :aria-label="text.preview" data-preview-pane :data-ready="selected !== null && drawnVersion === selected" :data-shown="drawnVersion ?? undefined">
            <Cluster gap="2" align="center">
              <h2>{{ selectedVersion ? text.previewOf(timeOf(selectedVersion)) : text.preview }}</h2>
              <PlayerControls v-if="previewed" :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="togglePlay" @stop="stop" />
            </Cluster>
            <p class="versions__muted">{{ selected === null ? text.choose : text.previewHelp }}</p>
            <p v-if="previewError" class="versions__error" role="alert">{{ previewError }}</p>
            <div class="versions__score-host">
              <div ref="host"></div>
            </div>
          </section>
        </div>
      </Stack>
      <AppConfirmDialog
        :visible="restoring !== null"
        :title="text.restore.title"
        :message="restoring ? text.restore.message(timeOf(restoring), undoKey) : ''"
        :confirm-label="text.restore.confirm"
        :cancel-label="text.cancel"
        :loading-label="strings.loading"
        confirm-variant="danger"
        data-confirm-restore
        @close="restoring = null"
        @confirm="restore"
      />
    </main>
  </template>
</template>

<style scoped>
.versions {
  max-width: 90rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.versions h1,
.versions h2 {
  margin: 0;
}
.versions h2 {
  font-size: 1.125rem;
}
.versions__score {
  margin-left: 0.75rem;
  color: var(--text-muted);
  font-size: 1rem;
  font-weight: 400;
}
.versions__muted {
  margin: 0;
  color: var(--text-muted);
}
.versions__error {
  margin: 0;
  color: var(--danger);
}
.versions__save {
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.versions__body {
  display: grid;
  grid-template-columns: minmax(18rem, 26rem) minmax(0, 1fr);
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 767px) {
  .versions__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
.versions__list ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.versions__item {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.versions__item--selected {
  border-color: var(--accent, var(--text));
}
.versions__line {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  font-variant-numeric: tabular-nums;
}
.versions__time {
  font-weight: 600;
}
.versions__name {
  overflow-wrap: anywhere;
}
.versions__tag {
  margin-right: 0.5rem;
  padding: 0 0.375rem;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.versions__preview {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.versions__score-host {
  min-height: 12rem;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
</style>
