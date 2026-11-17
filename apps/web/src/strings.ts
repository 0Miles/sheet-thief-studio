// Every text of the interface, in Traditional Chinese (the only language of the app).
import { accountLimits, DELETED_SCORE_DAYS, type ErrorCode } from "@studio/contracts";
import type { SessionHint } from "@studio/score-editor";
import { type Flag, type KeySignature, MAX_BARS, MAX_NON_PERCUSSION_PARTS, MAX_PARTS, type PartKind, type PartPresetId, type PitchedClef, type TimeSignature, type TuningOption } from "@studio/score-model";

import type { ReadOnlyReason } from "./access";
import type { WhilePlaying } from "./mixer";

/** The tonic of each key, by the number of sharps (positive) or flats (negative) plus 7. */
const KEY_TONICS: Record<KeySignature["mode"], readonly string[]> = {
  major: ["C♭", "G♭", "D♭", "A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯"],
  minor: ["A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯", "G♯", "D♯", "A♯"],
};

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
    // The banner while the connection is down (docs/spec/views.md, section 10): in the edit view
    // one types in, and in any other (a Viewer's, the Read view, a guest's).
    offline: {
      editing: "離線中。可以繼續編輯，恢復連線後會自動合併。",
      reading: "離線中，恢復連線後會繼續更新。",
    },
    viewerCannotEdit: "檢視者無法修改",
    // What a reconnection found changed, said on the score opened anew (docs/spec/collab.md, section 7).
    roleChanged: (role: string) => `你的角色已改為${role}。`,
    // Why nobody may change the score here, whatever their role (docs/spec/views.md, section 10).
    readOnly: {
      newerSchema: "這份團譜由較新的版本建立，請重新整理頁面。",
      missingMigration: "伺服器還不能讀這份團譜，暫時只能檢視。",
      migrationFailed: "伺服器讀這份團譜時發生錯誤，暫時只能檢視。",
    } satisfies Record<ReadOnlyReason, string>,
    // The 404 page of a member removed from the score, or of a score deleted, while it was open.
    removed: "你已經不是這份團譜的成員，或團譜已被刪除。",
    // The box Enter opens for the text over a beat, such as a chord name.
    beatText: "拍點文字",
    // What a key that did nothing tells the member (`SessionHint`).
    hints: {
      oneVoice: "弦樂聲部只有一條聲線",
      tooManyBars: `小節最多 ${MAX_BARS} 個`,
      lastBar: "至少要留下一個小節",
      tooManyParts: `聲部最多 ${MAX_PARTS} 個，其中鼓以外最多 ${MAX_NON_PERCUSSION_PARTS} 個`,
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
      bar: (bar: number) => `第 ${bar} 小節`,
      range: (first: number, last: number) => `第 ${first}–${last} 小節`,
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
    player: {
      loading: "音色載入中…",
      play: "播放",
      pause: "暫停",
      stop: "停止",
      bar: (bar: number) => `第 ${bar} 小節`,
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
      loopBars: (first: number, last: number) => (first === last ? `第 ${first} 小節` : `第 ${first}–${last} 小節`),
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
      rule: `顯示名稱長度 ${accountLimits.displayName.min}–${accountLimits.displayName.max} 個字元。`,
      save: "儲存",
      saved: "已儲存",
    },
    password: {
      title: "變更密碼",
      current: "目前的密碼",
      new: "新密碼",
      again: "再輸入一次新密碼",
      rule: `密碼長度 ${accountLimits.password.min}–${accountLimits.password.max} 個字元。`,
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
      displayName: `顯示名稱長度 ${accountLimits.displayName.min}–${accountLimits.displayName.max} 個字元。`,
      password: `密碼長度 ${accountLimits.password.min}–${accountLimits.password.max} 個字元。`,
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
  } satisfies Partial<Record<ErrorCode, string>>,
  unknownError: "發生錯誤，請稍後再試。",
  loading: "載入中…",
} as const;

/** What to tell the person about an error answer. */
export function errorText(code: ErrorCode): string {
  return (strings.errors as Partial<Record<ErrorCode, string>>)[code] ?? strings.unknownError;
}
