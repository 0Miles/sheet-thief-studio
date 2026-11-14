// Every text of the interface, in Traditional Chinese (the only language of the app).
import type { ErrorCode } from "@studio/contracts";

export const strings = {
  app: {
    name: "Sheet Thief Studio",
  },
  home: {
    title: "我的團譜",
    newScore: "新增團譜",
    empty: "還沒有團譜。按「新增團譜」建立第一份。",
    roles: { owner: "擁有者", editor: "編輯者", viewer: "檢視者" },
  },
  newScore: {
    title: "新增團譜",
    scoreTitle: "標題",
    create: "建立",
    cancel: "取消",
    close: "關閉",
  },
  score: {
    unavailable: "無法開啟這份團譜",
    label: "譜面",
    sync: { syncing: "同步中…", synced: "已同步", offline: "離線" },
    viewerCannotEdit: "檢視者無法修改",
    dismiss: "關閉",
    settings: "設定",
    player: {
      loading: "音色載入中…",
      play: "播放",
      pause: "暫停",
      stop: "停止",
      bar: (bar: number) => `第 ${bar} 小節`,
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
  } satisfies Partial<Record<ErrorCode, string>>,
  unknownError: "發生錯誤，請稍後再試。",
  loading: "載入中…",
  // The M0 spike page. Temporary: it goes away when the real editor arrives.
  spike: {
    title: "技術驗證",
    local: "本機（不共編）",
    connecting: "連線中…",
    connected: "已連線",
    disconnected: "已斷線",
    parts: "顯示聲部",
    allParts: "全部聲部",
    play: "播放",
    pause: "暫停",
    playerLoading: "音色載入中…",
    // What the keys do; their names come from the keymap, for this platform (docs/spec/keymap.md, 1.3).
    keys: { move: "移動", fret: "輸入格號", insertBeat: "新增拍點", duration: "改時值", delete: "清除", undo: "復原", redo: "重做" },
    flags: (count: number) => `${count} 個標記`,
    scoreLabel: "譜面",
  },
} as const;

/** What to tell the person about an error answer. */
export function errorText(code: ErrorCode): string {
  return (strings.errors as Partial<Record<ErrorCode, string>>)[code] ?? strings.unknownError;
}
