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
    keys: "方向鍵移動　數字輸入格號　Insert 新增拍點　+ / − 改時值　Delete 清除　Ctrl+Z / Ctrl+Y 復原 / 重做",
    flags: (count: number) => `${count} 個標記`,
    scoreLabel: "譜面",
  },
} as const;

/** What to tell the person about an error answer. */
export function errorText(code: ErrorCode): string {
  return (strings.errors as Partial<Record<ErrorCode, string>>)[code] ?? strings.unknownError;
}
