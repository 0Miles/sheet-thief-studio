// Every text of the interface, in Traditional Chinese (the only language of the app).
import {
  accountLimits,
  type ClosedNotice,
  DELETED_SCORE_DAYS,
  type ErrorCode,
  type PhraseSummary,
  type RecognitionError,
  recognitionLimits,
  type RecognitionSkipped,
  type RecognitionStatus,
  type RecognizerPageError,
  type RecognizerWarning,
  versionLimits,
  type VersionReason,
} from "@studio/contracts";
import type { SessionHint } from "@studio/score-editor";
import { type DropHint, type DropRefusal, type Flag, type KeySignature, MAX_BARS, MAX_NON_PERCUSSION_PARTS, MAX_PARTS, type PartKind, type PartPresetId, type PitchedClef, type TimeSignature, type TuningOption } from "@studio/score-model";

import type { ReadOnlyReason } from "./access";
import type { WhilePlaying } from "./mixer";

/** The tonic of each key, by the number of sharps (positive) or flats (negative) plus 7. */
const KEY_TONICS: Record<KeySignature["mode"], readonly string[]> = {
  major: ["C♭", "G♭", "D♭", "A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯"],
  minor: ["A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯", "G♯", "D♯", "A♯"],
};

// Texts said the same in more than one place.
const DISPLAY_NAME_RULE = `顯示名稱長度 ${accountLimits.displayName.min}–${accountLimits.displayName.max} 個字元。`;
const PASSWORD_RULE = `密碼長度 ${accountLimits.password.min}–${accountLimits.password.max} 個字元。`;
const TOO_MANY_PARTS = `聲部最多 ${MAX_PARTS} 個，其中鼓以外最多 ${MAX_NON_PERCUSSION_PARTS} 個`;
const TOO_MANY_BARS = `小節最多 ${MAX_BARS} 個`;
const VERSIONS = "版本記錄";
const BEFORE_RESTORE = "還原前";
const barLabel = (bar: number) => `第 ${bar} 小節`;
const barRangeLabel = (first: number, last: number) => `第 ${first}–${last} 小節`;
/** Bars from one to another, one bar by its number alone. */
const barsLabel = (first: number, last: number) => (first === last ? barLabel(first) : barRangeLabel(first, last));
const SAVE_PHRASE = "存成樂句";
const PHRASE_LIBRARY = "樂句庫";
const NO_PHRASES = "還沒有樂句。";
const NO_MATCHING_PHRASES = "沒有符合的樂句。";
/** The images a recognition takes (docs/spec/recognizer.md, section 1), and how many at once. */
const IMAGE_TYPES = "PNG、JPEG 或 WebP";
const MOST_IMAGES = `一次最多 ${recognitionLimits.images.max} 張`;
const RECOGNITION_FAILED = "辨識失敗";
const megabytes = (bytes: number) => bytes / (1024 * 1024);

export const strings = {
  app: {
    name: "Sheet Thief Studio",
  },
  home: {
    title: "我的團譜",
    newScore: "新增團譜",
    empty: "還沒有團譜。按「新增團譜」建立第一份。",
    phrases: PHRASE_LIBRARY,
    roles: { owner: "擁有者", editor: "編輯者", viewer: "檢視者" },
    // The scores I own and deleted, which I can still restore (docs/spec/accounts.md, section 8).
    deleted: {
      title: "已刪除",
      help: `刪除後 ${DELETED_SCORE_DAYS} 天內可以還原，之後會永久刪除。還原後唯讀連結要重新產生。`,
      until: (date: string) => `${date} 永久刪除`,
      restore: "還原",
      restoreOf: (title: string) => `還原「${title}」`,
    },
  },
  // The dialog of a new score (docs/spec/commands.md, section 10).
  newScore: {
    title: "新增團譜",
    scoreTitle: "標題",
    parts: "聲部",
    preset: "聲部種類",
    count: "數量",
    tuning: "調弦",
    tunings: { standard: "標準", drop: "Drop（最低弦降全音）", halfDown: "降半音", wholeDown: "降全音", custom: "逐弦自訂" } satisfies Record<TuningOption | "custom", string>,
    string: (string: number) => `第 ${string} 弦`,
    addPart: "再加一種聲部",
    removePart: "移除",
    tooManyParts: TOO_MANY_PARTS,
    beats: "每小節拍數",
    beatUnit: "拍的單位",
    beatUnits: { 1: "全音符", 2: "二分音符", 4: "四分音符", 8: "八分音符", 16: "十六分音符", 32: "三十二分音符" } satisfies Record<TimeSignature["denominator"], string>,
    tempo: "速度（每分鐘四分音符數）",
    create: "建立",
    cancel: "取消",
    close: "關閉",
  },
  score: {
    unavailable: "無法開啟這份團譜",
    label: "譜面",
    sync: { syncing: "同步中…", synced: "已同步", offline: "離線" },
    // The banner while the connection is down (docs/spec/views.md, section 10): in the edit view
    // one types in, and in any other (a Viewer's, the Read view, a guest's).
    offline: {
      editing: "離線中。可以繼續編輯，恢復連線後會自動合併。",
      reading: "離線中，恢復連線後會繼續更新。",
    },
    viewerCannotEdit: "檢視者無法修改",
    // The members on the score now (docs/spec/views.md, section 8): each once, a member who only
    // reads marked so; their names are those they chose.
    presence: {
      members: "正在看這份團譜的成員",
      reading: "（檢視中）",
    },
    // What a reconnection found changed, said on the score opened anew (docs/spec/collab.md, section 7).
    roleChanged: (role: string) => `你的角色已改為${role}。`,
    // Why nobody may change the score here, whatever their role (docs/spec/views.md, section 10).
    // Locked until the page is loaded again: each says so.
    readOnly: {
      newerSchema: "這份團譜由較新的版本建立，請重新整理頁面。",
      missingMigration: "伺服器還不能讀這份團譜，暫時只能檢視；伺服器更新後請重新整理頁面。",
      migrationFailed: "伺服器讀這份團譜時發生錯誤，暫時只能檢視；問題排除後請重新整理頁面。",
    } satisfies Record<ReadOnlyReason, string>,
    // Locked while open for typing, the score opened anew from the server's document: what this
    // tab wrote and the server never took went with the old one (docs/spec/collab.md, 2.1).
    readOnlyDropped: (why: string) => `已改用伺服器上的版本，這個分頁沒同步到伺服器的修改已經丟掉。${why}`,
    // The server closed this tab's connection for good (docs/spec/collab.md, section 9): what it
    // holds would be refused again at every reconnection. Opening the score anew drops it.
    closed: {
      reasons: {
        tooDeep: "這個分頁裡有伺服器不接受的內容（巢狀太深的資料），已停止同步，之後的修改也不會儲存。重新載入會改用伺服器上的版本，這個分頁還沒儲存的修改會全部丟掉。",
      } satisfies Record<ClosedNotice["reason"], string>,
      reload: "重新載入",
      reloaded: "已重新載入伺服器上的版本，先前那個分頁沒儲存的修改已丟掉。",
    },
    // The 404 page of a member removed from the score, or of a score deleted, while it was open.
    removed: "你已經不是這份團譜的成員，或團譜已被刪除。",
    // The box Enter opens for the text over a beat, such as a chord name.
    beatText: "拍點文字",
    // The box of lyrics mode (Shift+Enter on a staff), and why a syllable with its - was not saved.
    lyrics: "歌詞",
    lyricTooLong: (max: number) => `一個音節最多 ${max} 個字元`,
    // What a key that did nothing tells the member (`SessionHint`).
    hints: {
      oneVoice: "弦樂聲部只有一條聲線",
      tooManyBars: TOO_MANY_BARS,
      lastBar: "至少要留下一個小節",
      tooManyParts: TOO_MANY_PARTS,
      lastPart: "至少要留下一個聲部",
    } satisfies Record<SessionHint, string>,
    // A title read as empty (co-editing can empty it; docs/spec/schema.md, section 2).
    untitled: "未命名",
    // The title and the artist, changed in the title bar of the editable view (docs/spec/commands.md, 7.3).
    heading: {
      edit: "修改標題",
      editTitle: "修改標題與演出者",
      title: "標題",
      artist: "演出者",
      artistHelp: "留空表示不寫演出者",
      apply: "套用",
      cancel: "取消",
    },
    // The panel of the parts (docs/spec/commands.md, 7.1 and 7.2): the editable view only.
    parts: {
      panel: "聲部",
      panelTitle: "新增、刪除、排序聲部，修改聲部屬性",
      close: "關閉",
      list: "聲部（拖動可以排序）",
      kinds: { fretted: "弦樂", percussion: "鼓", pitched: "五線譜" } satisfies Record<PartKind, string>,
      strings: (count: number) => `${count} 弦`,
      drag: (name: string) => `拖動「${name}」排序`,
      edit: (name: string) => `修改「${name}」的屬性`,
      moveUp: (name: string) => `把「${name}」往上移`,
      moveDown: (name: string) => `把「${name}」往下移`,
      up: "上移",
      down: "下移",
      remove: "刪除",
      removeOf: (name: string) => `刪除「${name}」`,
      add: "新增聲部",
      preset: "聲部種類",
      tuning: "調弦",
      atLimit: `聲部已經到上限：最多 ${MAX_PARTS} 個，其中鼓以外最多 ${MAX_NON_PERCUSSION_PARTS} 個`,
      properties: (name: string) => `「${name}」的屬性`,
      fixed: "聲部種類、弦數與譜表數建立後不能改。",
      name: "名稱",
      tuningHelp: "格號不變，所以音高會跟著調弦改變。",
      capo: "移調夾（第幾格，0 是沒有）",
      program: "音色（General MIDI 編號 0–127）",
      clef: (staff: number) => `第 ${staff} 個譜表的譜號`,
      clefs: { treble: "高音譜號", bass: "低音譜號", "treble-8vb": "高音譜號（低八度）" } satisfies Record<PitchedClef, string>,
      clefHelp: "譜號只影響顯示，音高不變。",
      apply: "套用",
      // Asked before a part goes with all it holds: deleting bars asks nothing, deleting a part does (commands.md, 7.1).
      confirmDelete: {
        title: "刪除聲部",
        message: (name: string, bars: number) =>
          `${bars === 0 ? `要刪除「${name}」嗎？它沒有任何內容。` : `要刪除「${name}」嗎？它有 ${bars} 個小節有內容，會一起刪除。`}刪除之後可以用復原找回來。`,
        confirm: "刪除",
        cancel: "取消",
      },
    },
    // Bars inserted and deleted, and the panel of the cursor's bar (docs/spec/commands.md, section 6):
    // the toolbar's buttons say the key of this platform, the panel works on every part.
    bars: {
      insert: "插入小節",
      insertKey: (key: string) => `在游標所在的小節之前插入小節（${key}）`,
      remove: "刪除小節",
      removeKey: (key: string) => `刪除游標所在的小節，或選取的小節（${key}）`,
      append: "＋小節",
      appendTitle: "在譜尾加一個小節",
      panel: "小節屬性",
      panelKey: (key: string) => `開關小節屬性面板（${key}）`,
      bar: barLabel,
      range: barRangeLabel,
      allParts: "會改動所有聲部",
      timeSig: "拍號",
      timeSigOnward: "套用到這個小節，直到下一個不同的拍號",
      timeSigRange: "套用到選取的每一個小節",
      tempo: "速度（每分鐘四分音符數）",
      tempoHere: "從這個小節起",
      tempoInherited: (tempo: number) => `沒有變化，沿用 ${tempo}`,
      clearTempo: "清除速度",
      keySig: "調號",
      keyMode: "大小調",
      keyModes: { major: "大調", minor: "小調" } satisfies Record<KeySignature["mode"], string>,
      key: "調",
      /** A key by name and by what it writes, such as 「B♭ 大調（2 個降記號）」. */
      keyName: ({ fifths, mode }: KeySignature) => {
        const tonic = KEY_TONICS[mode][fifths + 7];
        const marks = fifths === 0 ? "沒有升降記號" : fifths > 0 ? `${fifths} 個升記號` : `${-fifths} 個降記號`;
        return `${tonic} ${mode === "major" ? "大調" : "小調"}（${marks}）`;
      },
      keySigHere: (bar: number) => `從第 ${bar} 小節起`,
      keySigInherited: (bar: number, name: string) => `第 ${bar} 小節沒有變化，沿用 ${name}`,
      clearKeySig: "清除調號",
      section: "段落名稱",
      sectionHere: (bar: number) => `從第 ${bar} 小節開始的段落，例如「主歌」、「副歌」`,
      clearSection: "清除段落名稱",
      repeat: "反覆",
      repeatTimes: "總共演奏幾次",
      repeatOnBar: "反覆開始與結束都寫在這個小節",
      repeatOnRange: (first: number, last: number) => `反覆開始寫在第 ${first} 小節，結束寫在第 ${last} 小節`,
      repeatStartHere: "這裡是反覆開始",
      repeatEndHere: (times: number) => `這裡是反覆結束，總共演奏 ${times} 次`,
      setRepeat: "設定反覆",
      clearRepeatStart: "清除反覆開始",
      clearRepeatEnd: "清除反覆結束",
      voltas: "跳房子：只在勾選的第幾遍演奏",
      voltaPass: (pass: number) => `第 ${pass} 遍`,
      voltasOnBar: "寫在這個小節",
      voltasOnRange: "寫在選取的每一個小節",
      // Told only, not refused: a repeat set or changed later can make the pass sound (docs/spec/commands.md, section 6).
      voltasUnplayed: (passes: readonly number[], times: number) =>
        `${times === 1 ? "這裡沒有反覆" : `對應的反覆總共只演奏 ${times} 次`}，第 ${passes.join("、")} 遍不會演奏`,
      clearVoltas: "清除跳房子",
      anacrusis: "弱起小節",
      anacrusisHelp: "只有第一小節可以是弱起小節。它的長度是裡面最長的聲線，不標時值不足。",
      apply: "套用",
      close: "關閉",
    },
    dismiss: "關閉",
    settings: "設定",
    versions: VERSIONS,
    player: {
      loading: "音色載入中…",
      unavailable: "這個瀏覽器無法播放聲音",
      failed: "音色載入失敗",
      retry: "重試",
      play: "播放",
      pause: "暫停",
      stop: "停止",
      bar: barLabel,
    },
    // Each member's own playback settings (docs/spec/playback.md, sections 1 and 3).
    mixer: {
      open: "混音",
      openTitle: "各聲部的靜音、獨奏、音量，播放速度、節拍器與預備拍",
      title: "混音",
      close: "關閉",
      mute: "靜音",
      solo: "獨奏",
      volume: "音量",
      muteOf: (part: string) => `${part}：靜音`,
      soloOf: (part: string) => `${part}：獨奏`,
      volumeOf: (part: string) => `${part}：音量`,
      percent: (value: number) => `${Math.round(value * 100)}%`,
      shared: "和其他聲部共用聲道：靜音、獨奏與音量會一起作用在那些聲部上",
      speed: "播放速度",
      loop: "循環",
      loopNone: "沒有選取範圍（選取小節或拍點就會循環播放）",
      loopBars: barsLabel,
      loopBeats: (bar: number) => `第 ${bar} 小節裡選取的拍點`,
      metronome: "節拍器",
      countIn: "預備拍（一小節）",
      whilePlaying: "播放中修改",
      modes: {
        a: "停止輸入後重新產生聲音",
        b: "暫停、停止或循環回頭時才更新",
      } satisfies Record<WhilePlaying, string>,
      // Behaviour (b), while what plays is the score before a change (docs/spec/views.md, section 10).
      behind: "播放的是修改前的內容",
    },
    // What is wrong in the score, pointed out only (docs/spec/flags.md): how many, the next one, and what each kind is.
    flags: {
      count: (count: number) => `標記 ${count}`,
      next: "下一個標記",
      nextKey: (key: string) => `跳到下一個標記（${key}）`,
      kinds: {
        underfull: "這條聲線的時值少於拍號",
        overfull: "這條聲線的時值超出拍號",
        danglingTie: "連結線前面沒有同一個音可以連接",
        danglingLink: "搥弦、勾弦或連到下一個音的滑音後面沒有音",
        invalidContent: "這裡有讀不懂的內容，已經略過",
      } satisfies Record<Flag["kind"], string>,
    },
    // The phrase sidebar of the editable view (docs/spec/phrases.md, section 6): my phrases, those
    // that fit the cursor's part unless all are asked for, a preview, and a drop on a bar.
    phraseSidebar: {
      open: "樂句側欄",
      openKey: (key: string) => `開關樂句側欄（${key}）`,
      title: "樂句",
      close: "關閉",
      search: "搜尋樂句",
      showAll: "顯示全部，包含和游標所在聲部不相容的",
      help: "拖到譜面上的小節放下，或選好樂句按 Enter 放到游標所在的小節。",
      empty: NO_PHRASES,
      noneFit: "沒有和游標所在聲部相容的樂句。",
      noMatch: NO_MATCHING_PHRASES,
      library: PHRASE_LIBRARY,
      preview: (name: string) => `「${name}」的預覽`,
      closePreview: "關閉預覽",
      dropAtCursor: "放到游標所在的小節",
      /** Over a part of another kind, while a phrase is dragged over it. */
      cannotDrop: "不能放",
      // What a drop tells, no dialog (docs/spec/commands.md, 5.7).
      hints: {
        tuningDiffers: "調弦不同，格號照原樣放入",
        barsAppended: "小節不夠，已在譜尾附加小節",
      } satisfies Record<DropHint, string>,
      refused: {
        gone: "要放的小節或聲部已經不在了",
        otherKind: "只能放進同一種聲部",
        tooManyStrings: "樂句用到的弦超過這個聲部的弦數",
        otherStaves: "樂句用到這個聲部沒有的譜表",
        tooManyBars: TOO_MANY_BARS,
        invalid: "這個樂句的內容讀不懂，沒有放入",
      } satisfies Record<DropRefusal, string>,
    },
    // Each member's own display options (docs/spec/views.md, section 6).
    display: {
      parts: "顯示聲部",
      zoom: "縮放",
      scale: (scale: number) => `${Math.round(scale * 100)}%`,
      // The narrow Read view: one part at a time, the rest of the options in a drawer.
      part: "聲部",
      options: "選項",
      closeOptions: "收起選項",
    },
  },
  // The phrase library (/phrases; docs/spec/phrases.md, section 4).
  phrases: {
    title: PHRASE_LIBRARY,
    newPhrase: "新增樂句",
    empty: NO_PHRASES,
    noMatch: NO_MATCHING_PHRASES,
    kind: "種類",
    allKinds: "全部",
    kinds: { fretted: "弦樂 TAB", percussion: "鼓", pitched: "五線譜" } satisfies Record<PartKind, string>,
    search: "搜尋名稱",
    strings: (count: number) => `${count} 弦`,
    staves: (count: number) => `${count} 個譜表`,
    bars: (count: number) => `${count} 小節`,
    /** What a list says of a phrase besides its name, in the library and in the sidebar: its kind, its strings or its staves (more than one), its bars. */
    details: (phrase: Pick<PhraseSummary, "kind" | "stringCount" | "staffCount" | "barCount">) =>
      [
        strings.phrases.kinds[phrase.kind],
        phrase.stringCount === null ? null : strings.phrases.strings(phrase.stringCount),
        phrase.staffCount !== null && phrase.staffCount > 1 ? strings.phrases.staves(phrase.staffCount) : null,
        strings.phrases.bars(phrase.barCount),
      ]
        .filter((part) => part !== null)
        .join(" · "),
    rename: "改名",
    duplicate: "複製",
    delete: "刪除",
    /** Recognizing images of a TAB (docs/spec/phrases.md, sections 4 and 7): on every device. */
    recognize: "從圖片辨識",
    recognizeHelp: `${IMAGE_TYPES}，${MOST_IMAGES}，依頁序選取。`,
    uploading: "上傳中…",
    tooManyImages: `${MOST_IMAGES}圖片。`,
    /** Refused for an upload with no image in it (400 on `images`). */
    noImages: "請至少選擇一張圖片。",
    /** Refused for a body the server could not read as images (400 without fields): the files could not be sent as they are. */
    uploadUnreadable: "無法讀取上傳的檔案，請重新選擇圖片再試一次。",
    /** Refused for its size (413): the limits of docs/spec/recognizer.md, section 4. */
    imagesTooLarge: `檔案太大：每張最多 ${megabytes(recognitionLimits.imageBytes)} MB，合計最多 ${megabytes(recognitionLimits.imagesBytes)} MB。`,
    /** Refused for its type (415): which image, from 1. */
    unsupportedImage: (page: number) => `第 ${page} 張不是 ${IMAGE_TYPES} 圖片（例如 HEIC 要先轉檔）。`,
    /** The recognitions not yet saved nor discarded. */
    pending: "待審核",
    pendingItem: (pages: number, at: string) => `${at} · ${pages} 張圖片`,
    pendingStatus: { running: "辨識中", succeeded: "可以審核", failed: RECOGNITION_FAILED } satisfies Record<RecognitionStatus, string>,
  },
  // The review page of a recognition (/recognitions/:id; docs/spec/phrases.md, section 7, and
  // docs/spec/recognizer.md): progress, why it failed, and the result opened in the phrase editor.
  recognition: {
    title: "辨識結果",
    library: PHRASE_LIBRARY,
    running: "辨識中，完成後會自動顯示結果。辨識一份 TAB 可能要幾分鐘。",
    /** The headline of a failure: that it failed, and why. */
    failed: (reason: string) => `${RECOGNITION_FAILED}：${reason}`,
    /** Why a recognition failed, and what to try (docs/spec/recognizer.md, 5.2). */
    failures: {
      recognition_failed: { reason: "沒有辨識出 TAB。", advice: "請確認圖片是吉他或貝斯的 TAB，拍得清楚、沒有歪斜，再試一次。" },
      timeout: { reason: "辨識超過時間上限。", advice: "請減少一次上傳的張數，或把圖片裁成只有 TAB 的部分再試一次。" },
      unavailable: { reason: "辨識服務暫時無法使用。", advice: "請稍後再試一次。" },
      busy: { reason: "辨識服務正在處理別人的圖片。", advice: "請稍後再試一次。" },
      interrupted: { reason: "伺服器在辨識途中重新啟動，這次辨識沒有完成。", advice: "請重新上傳一次。" },
    } satisfies Record<RecognitionError["code"], { reason: string; advice: string }>,
    /** A page's own reason (docs/spec/recognizer.md, 5.2). */
    pageFailure: (page: number, code: RecognizerPageError["code"]) =>
      `第 ${page} 張：${
        {
          no_staff: "找不到譜表的線，請確認這張是 TAB。",
          no_notes: "找到譜表，但讀不到格號，請拍得更清楚一些。",
          invalid_image: "圖片無法讀取，檔案可能損壞。",
          image_too_large: "圖片太大（超過 40 百萬像素），請縮小後再試。",
        }[code]
      }`,
    /** What the fragment leaves out of what was read (docs/spec/recognizer.md, 7.2). */
    skippedTitle: "略過的項目",
    noneSkipped: "沒有略過任何項目。",
    skipped: (item: RecognitionSkipped): string => {
      switch (item.code) {
        case "grace_notes":
          return `裝飾音 ${item.count} 個（樂句不帶裝飾音）`;
        case "capo":
          return `移調夾第 ${item.fret} 格（樂句不帶移調夾）`;
        case "tuning_unrecognized":
          return `讀不懂的調弦「${item.raw}」`;
        case "bend_clamped":
          return `超過 4 個半音的推弦 ${item.count} 個，改成 4 個半音`;
        case "sections":
          return "段落名稱";
        case "tempo":
          return "速度";
        case "repeats":
          return "反覆記號與跳房子";
        case "jumps":
          return "反覆指示（Segno、Coda 等）";
      }
    },
    warningsTitle: "提醒",
    warning: (item: RecognizerWarning): string => {
      switch (item.code) {
        case "rhythm_estimated":
          return `${item.params.bars.map(barLabel).join("、")}的時值是從音符間距估出來的，請檢查`;
        case "overlapping_notes":
          return `第 ${item.params.page} 張有 ${item.params.count} 個同一條弦上重疊的音符被略過`;
        case "staves_ignored":
          return `${item.params.count} 行弦數和其他行不同的譜表被略過`;
        case "bar_too_dense":
          return `第 ${item.params.page} 張有個小節的音太多，這個小節的音都當成 32 分音符`;
        case "fixed_durations":
          return "不是每一行都有小節線，時值用固定長度，請檢查";
        case "other":
          return "辨識時有其他提醒，請仔細檢查結果";
      }
    },
    /** The tuning as read (docs/spec/recognizer.md, section 6). */
    tuningNotFound: "圖片上沒有讀到調弦，先用標準調弦。",
    tuningUnrecognized: (raw: string) => `讀不懂圖片上的調弦「${raw}」，先用標準調弦。請確認調弦，需要時手動選擇。`,
    chooseTuning: "選擇調弦",
    images: "原圖",
    imageAlt: (page: number) => `第 ${page} 張原圖`,
    save: SAVE_PHRASE,
    discard: "捨棄",
    /** The name a phrase saved from a recognition starts with: the day it was recognized. */
    defaultName: (day: string) => `辨識結果 ${day}`,
    edited: `有修改尚未${SAVE_PHRASE}`,
    /** On a phone or a tablet the result is only looked at and played (`canType`). */
    desktopOnly: `請在電腦上審核並${SAVE_PHRASE}`,
    saveDialog: { title: SAVE_PHRASE, name: "名稱", save: "儲存", cancel: "取消", close: "關閉" },
    discardDialog: {
      title: "捨棄辨識結果",
      message: "要捨棄這次辨識嗎？辨識結果與原圖都會刪除，無法復原。",
      confirm: "捨棄",
      cancel: "取消",
    },
    /** Leaving for another page of the app with changes not saved as a phrase. */
    leave: {
      title: `修改還沒有${SAVE_PHRASE}`,
      message: `辨識結果的修改還沒有${SAVE_PHRASE}，離開之後就沒有了（辨識結果本身會保留）。要離開嗎？`,
      confirm: "離開",
      cancel: "留下",
    },
  },
  newPhrase: {
    title: "新增樂句",
    name: "名稱",
    defaultName: "未命名樂句",
    preset: "聲部",
    create: "建立",
    cancel: "取消",
    close: "關閉",
  },
  renamePhrase: {
    title: "樂句改名",
    name: "名稱",
    save: "儲存",
    cancel: "取消",
    close: "關閉",
  },
  deletePhrase: {
    title: "刪除樂句",
    message: (name: string) => `要刪除「${name}」嗎？刪除之後無法復原。`,
    confirm: "刪除",
    cancel: "取消",
  },
  // The phrase editor (/phrases/:id; docs/spec/phrases.md, section 5). Changed elsewhere and too
  // large are said with the texts of their error codes (`errors`).
  phraseEditor: {
    label: "樂句",
    library: PHRASE_LIBRARY,
    rename: "改名",
    parts: "調弦與譜號",
    save: { saved: "已儲存", waiting: "尚未儲存", saving: "儲存中…", conflict: "沒有儲存", unchecked: "沒有儲存", tooLarge: "沒有儲存", failed: "沒有儲存" },
    reload: "重新載入",
    saveAsNew: "另存成新樂句",
    /** The server could not be reached, or failed itself: saving is tried again by itself. */
    retrying: "無法儲存，稍後會自動再試。",
    /** Refused for its revision, and the phrase could not be read to tell why: nothing is sent until the member checks again. */
    unchecked: "無法確認這個樂句是否在別處被修改過，修改先留在這一頁。",
    /** Not saved, and not tried again by itself: what the server said, then this. */
    notSaved: (said: string) => `沒有儲存：${said}`,
    retry: "再試一次",
    /** Leaving the editor for another page of the app with changes the server does not have. */
    leave: {
      title: "還有修改沒有儲存",
      message: "這個樂句還有修改沒有存到伺服器，離開之後就沒有了。要離開嗎？",
      confirm: "離開",
      cancel: "留下",
    },
    /** On a phone or a tablet the phrase is only looked at and played (`canType`). */
    desktopOnly: "請在電腦上編輯",
  },
  // A range of bars of a score saved as a phrase, from either edit view (docs/spec/phrases.md, section 3).
  savePhrase: {
    /** The toolbar's button, and the title of its dialog. */
    open: SAVE_PHRASE,
    openTitle: `把選取的小節存進${PHRASE_LIBRARY}`,
    /** Why the button does nothing: no range of bars selected (a range of beats, or nothing). */
    barsOnly: "請選取小節範圍",
    name: "名稱",
    /** The name offered: the score's title and the bars, one bar by its number alone. */
    defaultName: (title: string, first: number, last: number) => `${title} ${barsLabel(first, last)}`,
    save: "儲存",
    cancel: "取消",
    close: "關閉",
    saved: (name: string) => `已${SAVE_PHRASE}「${name}」。`,
    /** Saved, without what could not be read in those bars (it is flagged in the score). */
    savedSkipping: (name: string) => `已${SAVE_PHRASE}「${name}」；讀不懂的內容已經略過，沒有存進去。`,
  },
  saveAsNewPhrase: {
    title: "另存成新樂句",
    name: "名稱",
    save: "儲存",
    cancel: "取消",
    close: "關閉",
  },
  // The part presets (docs/spec/commands.md, section 10).
  presets: {
    guitar6: "吉他 6 弦",
    guitar7: "吉他 7 弦",
    bass4: "貝斯 4 弦",
    bass5: "貝斯 5 弦",
    drums: "鼓",
    keys: "鍵盤",
    vocals: "人聲",
  } satisfies Record<PartPresetId, string>,
  // A score's versions (/scores/:id/versions; docs/spec/collab.md, section 8): every member looks
  // at them, an Owner or an Editor names them.
  versions: {
    title: VERSIONS,
    back: "回到團譜",
    help: "系統會在所有人離開團譜時、以及編輯中每 10 分鐘自動存一個版本，最多保留 200 個自動版本。命名的版本不會被自動刪除。",
    empty: "還沒有版本。",
    list: "版本",
    reasons: {
      last_disconnect: "自動（所有人離開時）",
      interval: "自動（每 10 分鐘）",
      before_restore: BEFORE_RESTORE,
      manual: "手動存下",
    } satisfies Record<VersionReason, string>,
    named: "已命名",
    size: (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`),
    preview: "預覽",
    previewOf: (when: string) => `${when} 的版本`,
    previewHelp: "預覽只供檢視與播放，不會改動團譜。",
    choose: "選一個版本來預覽。",
    name: "版本名稱",
    nameRule: `名稱長度 ${versionLimits.name.min}–${versionLimits.name.max} 個字元；清空後儲存會取消命名，它就和自動版本一樣可能被刪除。`,
    nameRuleManual: `名稱長度 ${versionLimits.name.min}–${versionLimits.name.max} 個字元。手動存下的版本一定要有名稱。`,
    rename: "命名",
    renameOf: (when: string) => `替 ${when} 的版本命名`,
    saveName: "儲存",
    cancel: "取消",
    save: {
      title: "把目前的內容存成版本",
      help: "存下伺服器上目前的內容，並替它命名。",
      submit: "存成版本",
    },
    // Restoring a version in place (docs/spec/collab.md, 8.5): Owners and Editors.
    restore: {
      action: "還原",
      title: "還原這個版本",
      message: (when: string, undoKey: string) =>
        `這會以 ${when} 的版本取代你這個分頁目前看到的內容；伺服器上目前的內容會先存成一個版本（「${BEFORE_RESTORE}」）。其他人在同一時間所做的修改會被取代，需要時可以從那個版本找回；他們剛新增、還沒同步到這裡的小節與聲部則會保留下來。還原之後，可以在團譜頁按 ${undoKey} 復原這次還原。`,
      confirm: "還原",
      notOpen: "團譜還在載入，或你目前不能修改它，請稍候再試。",
      notWritten: "這個版本沒辦法還原到目前的團譜。目前的內容已經存成一個版本。",
    },
  },
  // A guest's page, opened with a read-only link (/s/:token).
  guest: {
    sync: { syncing: "連線中…", synced: "已連線", offline: "已斷線" },
    gone: "這個唯讀連結已經失效。",
  },
  settings: {
    title: "團譜設定",
    back: "回到團譜",
    // Every member sees the list; only the Owner changes it (docs/spec/accounts.md, sections 3 to 6).
    members: {
      title: "成員",
      disabled: "已停用",
      add: {
        help: "輸入完整的帳號名稱。對方不會收到通知，下次打開「我的團譜」就會看到這份團譜。",
        username: "帳號名稱",
        role: "角色",
        submit: "加入成員",
      },
      roleOf: (username: string) => `${username} 的角色`,
      remove: "移除",
      transfer: {
        action: "轉移擁有權",
        title: "轉移擁有權",
        message: (displayName: string) => `要把擁有權轉給 ${displayName} 嗎？轉移之後你會變成編輯者，只有對方能管理成員、唯讀連結與刪除團譜。`,
        confirm: "轉移",
      },
      leave: {
        action: "離開團譜",
        title: "離開團譜",
        message: (title: string) => `要離開「${title}」嗎？離開之後你就打不開這份團譜，要請擁有者再把你加入。`,
        confirm: "離開",
      },
      cancel: "取消",
    },
    link: {
      title: "唯讀連結",
      help: "拿到連結的人不必登入，就能看譜與播放，但不能修改。重新產生或撤銷之後，舊的連結立刻失效。",
      none: "還沒有唯讀連結。",
      address: "連結網址",
      make: "產生連結",
      copy: "複製",
      copied: "已複製",
      remake: "重新產生",
      revoke: "撤銷連結",
    },
    // Only the Owner deletes the score (docs/spec/accounts.md, section 8).
    delete: {
      title: "刪除團譜",
      help: `刪除之後所有成員都打不開這份團譜，唯讀連結也會失效。${DELETED_SCORE_DAYS} 天內你可以在「我的團譜」的「已刪除」還原，之後會永久刪除。`,
      action: "刪除團譜",
      message: (title: string) => `要刪除「${title}」嗎？所有成員會立刻打不開它，唯讀連結會失效。${DELETED_SCORE_DAYS} 天內可以還原。`,
      confirm: "刪除",
      cancel: "取消",
    },
  },
  header: {
    logout: "登出",
    account: "帳號設定",
    admin: "後台",
  },
  // /account, and /account/password where a temporary password must be changed first (docs/spec/accounts.md, section 1).
  account: {
    title: "帳號設定",
    back: "回到我的團譜",
    username: (username: string) => `帳號名稱：${username}`,
    displayName: {
      title: "顯示名稱",
      label: "顯示名稱",
      rule: DISPLAY_NAME_RULE,
      save: "儲存",
      saved: "已儲存",
    },
    password: {
      title: "變更密碼",
      current: "目前的密碼",
      new: "新密碼",
      again: "再輸入一次新密碼",
      rule: PASSWORD_RULE,
      mismatch: "兩次輸入的新密碼不一樣。",
      submit: "變更密碼",
      changed: "密碼已變更，其他裝置已登出。",
    },
    forced: {
      title: "請先設定新密碼",
      help: "你是用管理者給的暫時密碼登入的，設定自己的密碼之後才能繼續。",
      submit: "設定密碼",
    },
    logoutAll: {
      title: "登出所有裝置",
      help: "包含這個裝置在內，所有已登入的裝置都會登出。",
      submit: "登出所有裝置",
    },
  },
  // /admin, for admins only (docs/spec/accounts.md, section 2).
  admin: {
    title: "後台",
    accounts: "帳號",
    newAccount: "建立帳號",
    isAdmin: "管理者",
    disabled: "已停用",
    reset: "重設密碼",
    disable: "停用",
    enable: "啟用",
    cancel: "取消",
    close: "關閉",
    rules: {
      username: `帳號名稱只能用小寫英數、- 與 _，長度 ${accountLimits.username.min}–${accountLimits.username.max} 個字元；建立後不能改。`,
      displayName: DISPLAY_NAME_RULE,
      password: PASSWORD_RULE,
    },
    create: {
      title: "建立帳號",
      username: "帳號名稱",
      displayName: "顯示名稱",
      password: "初始密碼",
      help: `初始密碼長度 ${accountLimits.password.min}–${accountLimits.password.max} 個字元。請把它交給本人；首次登入時要先設定自己的密碼。`,
      submit: "建立",
    },
    resetPassword: {
      title: (username: string) => `重設 ${username} 的密碼`,
      help: `設定一組暫時密碼（${accountLimits.password.min}–${accountLimits.password.max} 個字元）交給本人。這個帳號所有已登入的裝置都會登出，下次登入時要先設定自己的密碼。`,
      password: "暫時密碼",
      submit: "重設密碼",
    },
    disableAccount: {
      title: "停用帳號",
      message: (username: string) => `要停用 ${username} 嗎？這個帳號所有已登入的裝置都會登出，啟用之前不能登入。`,
      confirm: "停用",
    },
    // A disabled Owner's scores, which an admin can hand to a member who can log in (docs/spec/accounts.md, section 2).
    orphaned: {
      label: (username: string) => `${username} 擁有的團譜`,
      members: (title: string) => `「${title}」啟用中的成員`,
      member: (displayName: string, username: string, role: string) => `${displayName}（${username}，${role}）`,
      none: "沒有啟用中的成員，不能轉移擁有權。",
      transfer: "轉移擁有權",
    },
    transfer: {
      title: (scoreTitle: string) => `轉移「${scoreTitle}」的擁有權`,
      help: (owner: string) => `擁有者 ${owner} 已停用。把擁有權轉給一名啟用中的成員；轉移之後 ${owner} 會變成編輯者。`,
      to: "新的擁有者",
      option: (displayName: string, username: string) => `${displayName}（${username}）`,
      submit: "轉移",
    },
    transferred: (scoreTitle: string, username: string) => `已把「${scoreTitle}」的擁有權轉給 ${username}。`,
    created: (username: string) => `已建立帳號 ${username}。`,
    wasReset: (username: string) => `已重設 ${username} 的密碼。`,
    wasDisabled: (username: string) => `已停用 ${username}。`,
    wasEnabled: (username: string) => `已啟用 ${username}。`,
  },
  login: {
    username: "帳號名稱",
    password: "密碼",
    submit: "登入",
    help: "帳號由管理者建立；忘記密碼時請找管理者重設。",
    // A page found the session ended (logged out elsewhere, a new password, an account disabled).
    expired: "登入已失效，請重新登入。",
  },
  notFound: {
    title: "找不到這個頁面",
    message: "網址可能打錯了，或這個頁面已經不存在。",
    home: "回到我的團譜",
  },
  // Messages for the codes the API answers with (docs/spec/routes.md, section 4); a code without
  // one of its own shows `unknownError`.
  errors: {
    invalid_credentials: "帳號名稱或密碼錯誤。",
    rate_limited: "嘗試太多次，請稍後再試。",
    wrong_current_password: "目前的密碼不正確。",
    password_change_required: "請先設定新密碼。",
    forbidden: "你的角色不能做這件事。",
    account_not_found: "找不到這個帳號名稱。",
    already_member: "這個帳號已經是成員。",
    owner_cannot_leave: "擁有者要先轉移擁有權。",
    username_taken: "這個帳號名稱已經有人使用。",
    cannot_disable_self: "不能停用自己的帳號。",
    revision_conflict: "這個樂句在別處被修改過。",
    phrase_too_large: "樂句太大。",
    score_read_only: "伺服器暫時不能讀這份團譜，無法存成版本。",
    version_unreadable: "伺服器讀不了這個版本，無法預覽。",
    version_name_required: "手動存下的版本一定要有名稱。",
    recognition_in_progress: "你已經有一件辨識在進行，請等它完成再上傳。",
    recognizer_busy: "辨識服務正在處理別人的圖片，請稍後再試。",
    recognition_not_succeeded: `這次辨識沒有結果可以${SAVE_PHRASE}。`,
    unsupported_image: `只能上傳 ${IMAGE_TYPES} 圖片。`,
  } satisfies Partial<Record<ErrorCode, string>>,
  unknownError: "發生錯誤，請稍後再試。",
  loading: "載入中…",
} as const;

/** What to tell the person about an error answer. */
export function errorText(code: ErrorCode): string {
  return (strings.errors as Partial<Record<ErrorCode, string>>)[code] ?? strings.unknownError;
}
