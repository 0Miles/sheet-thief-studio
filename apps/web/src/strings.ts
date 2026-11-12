// Every text of the interface, in Traditional Chinese (the only language of the app).
export const strings = {
  app: {
    name: "Sheet Thief Studio",
    tagline: "樂團一起寫譜：多聲部團譜的線上即時共編。",
  },
  home: {
    newScore: "新增團譜",
  },
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
