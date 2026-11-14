// Every text of the interface, in Traditional Chinese (the only language of the app).
import type { ErrorCode } from "@studio/contracts";
import type { SessionHint } from "@studio/score-editor";
import { type Flag, MAX_NON_PERCUSSION_PARTS, MAX_PARTS, type PartKind, type PartPresetId, type TimeSignature, type TuningOption } from "@studio/score-model";

export const strings = {
  app: {
    name: "Sheet Thief Studio",
  },
  home: {
    title: "我的團譜",
    newScore: "新增團譜",
    empty: "還沒有團譜。按「新增團譜」建立第一份。",
    phrases: "樂句庫",
    roles: { owner: "擁有者", editor: "編輯者", viewer: "檢視者" },
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
    tooManyParts: `聲部最多 ${MAX_PARTS} 個，其中鼓以外最多 ${MAX_NON_PERCUSSION_PARTS} 個`,
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
    viewerCannotEdit: "檢視者無法修改",
    // The box Enter opens for the text over a beat, such as a chord name.
    beatText: "拍點文字",
    // What a key that did nothing tells the member (`SessionHint`).
    hints: { oneVoice: "弦樂聲部只有一條聲線" } satisfies Record<SessionHint, string>,
    dismiss: "關閉",
    settings: "設定",
    player: {
      loading: "音色載入中…",
      play: "播放",
      pause: "暫停",
      stop: "停止",
      bar: (bar: number) => `第 ${bar} 小節`,
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
        danglingLink: "搥弦、勾弦或滑音後面沒有音可以連過去",
        invalidContent: "這裡有讀不懂的內容，已經略過",
      } satisfies Record<Flag["kind"], string>,
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
    title: "樂句庫",
    newPhrase: "新增樂句",
    empty: "還沒有樂句。",
    noMatch: "沒有符合的樂句。",
    kind: "種類",
    allKinds: "全部",
    kinds: { fretted: "弦樂 TAB", percussion: "鼓", pitched: "五線譜" } satisfies Record<PartKind, string>,
    search: "搜尋名稱",
    strings: (count: number) => `${count} 弦`,
    staves: (count: number) => `${count} 個譜表`,
    bars: (count: number) => `${count} 小節`,
    rename: "改名",
    duplicate: "複製",
    delete: "刪除",
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
  // A guest's page, opened with a read-only link (/s/:token).
  guest: {
    sync: { syncing: "連線中…", synced: "已連線", offline: "已斷線" },
    gone: "這個唯讀連結已經失效。",
  },
  settings: {
    title: "團譜設定",
    back: "回到團譜",
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
  },
  header: {
    logout: "登出",
  },
  login: {
    username: "帳號名稱",
    password: "密碼",
    submit: "登入",
    help: "帳號由管理者建立；忘記密碼時請找管理者重設。",
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
    forbidden: "你的角色不能做這件事。",
    revision_conflict: "這個樂句在別處被修改過。",
    phrase_too_large: "樂句太大。",
  } satisfies Partial<Record<ErrorCode, string>>,
  unknownError: "發生錯誤，請稍後再試。",
  loading: "載入中…",
} as const;

/** What to tell the person about an error answer. */
export function errorText(code: ErrorCode): string {
  return (strings.errors as Partial<Record<ErrorCode, string>>)[code] ?? strings.unknownError;
}
