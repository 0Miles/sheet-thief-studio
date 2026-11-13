// Every text of the interface, in Traditional Chinese (the only language of the app).
export const strings = {
  app: {
    name: "Sheet Thief Studio",
    tagline: "樂團一起寫譜：多聲部團譜的線上即時共編。",
  },
  home: {
    newScore: "新增團譜",
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
  // Messages for the codes the API answers with (docs/spec/routes.md, section 4).
  errors: {
    invalid_credentials: "帳號名稱或密碼錯誤。",
    rate_limited: "嘗試太多次，請稍後再試。",
    unknown: "發生錯誤，請稍後再試。",
  } as Record<string, string>,
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
