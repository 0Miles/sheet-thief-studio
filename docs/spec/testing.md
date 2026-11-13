# 測試、CI、確認檢查、人工判定

標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 測試 seam

| 套件 | seam | 怎麼測 |
|---|---|---|
| `packages/score-model` | Command、`docToJson`、遷移、Flag、`jsonToDoc` | vitest 加真的 `Y.Doc`，不需要瀏覽器。同時修改用兩份 `Y.Doc` 互相套用更新（`coediting.test.ts` 的寫法） |
| `packages/score-editor` | `EditorSession`：Cursor、Selection、`UndoManager`、按鍵 → Command、唯讀旗標、Presence 的本機狀態；三種視圖的判定函式；平台層（抽象組合、`detectKeyPlatform`、`formatChord`） | vitest 加真的 `Y.Doc`，不需要瀏覽器。判定函式窮舉所有組合（[`views.md`](views.md)）；平台層對每個綁定、兩個平台跑同一組檢查（[`keymap.md`](keymap.md) 第 1.3 節） |
| `packages/score-render` | 投影、`replaceBars`、聲道分配、匯入、匯出 | vitest（jsdom）。聲音用 alphaTab 的 `MidiFileGenerator` 產生 MIDI 再檢查（`tests/sound.test.ts` 的寫法） |
| `apps/server` | API、session、權限、Hocuspocus 掛鉤、版本、定時工作 | vitest，一律打**真的** Postgres 與 Redis：本機用 `compose.dev.yaml`，CI 用 service containers；不 mock 資料庫。共編測試在 Node 裡用真的 `@hocuspocus/provider` 連線（Node 22 內建 WebSocket；CI 用 Node 22，`ci.yml:23`） |
| `apps/web` | 頁面與整合 | Playwright e2e，經由真的鍵盤與介面操作。**補充**（#19）：疊層避開保留區域的純函式（`src/overlay.ts`）另外有 vitest（`tests/overlay.test.ts`） |
| `services/recognizer` | 辨識核心、契約出口、#27 | pytest，在裝了 OCR 套件的 Docker image 裡跑 |
| 契約 | 辨識服務的中間模型 JSON | Python 與 TypeScript 兩邊讀同一批 fixture（[`recognizer.md`](recognizer.md)） |

- `packages/score-editor` 不碰 DOM、不依賴 `ScoreRenderer`、不知道 Hocuspocus、不 import y-protocols；給任何 `Y.Doc` 都能運作。點擊轉成 Cursor（`hitTest`）、幾何計算、寫入 `provider.awareness`，都由 Vue 殼負責。
- spike 的 `apps/web/src/spike/typing.ts` 與 `apps/web/tests/typing.test.ts` 已經搬進 `packages/score-editor`（`src/session.ts`、`tests/typing.test.ts`，#9）。
- `eslint.config.js:18` 禁止 import alphaTab 的清單已經包含 `packages/score-editor/**`。
- **補充**：`compose.dev.yaml` 的 Postgres 與 Redis 是 M1a 第一張 server 票建立的；伺服器測試用獨立的資料庫名稱，每個測試檔自己清資料。

## 2. 測試掛鉤與 build

取代 `window.__studio`（`apps/web/src/spike/hook.ts`）：

| 掛鉤 | 何時存在 | 內容 |
|---|---|---|
| `window.__studioTest` | 只在 `VITE_E2E=1` 的 build | 只有三個唯讀函式：`scoreJson()`、`cursor()`、`flags()` |
| `window.__studioMeasure` | 只在 `VITE_MEASURE=1` 的 build | 只給 measure 套件用：`placeCursor`、`editBar`、`bulkEdit`、`renders`、`keys`、`player.reload`、`player.trace`（`hook.ts:45-61`），以及 measure 套件現在讀的 `ready`、`synced`、`json`、`stateSize`、`cursorRect`、`errors`、`player.state`、`player.position`（補充） |

- 正式 build 兩者都沒有。加一個檢查，確認打包結果（`apps/web/dist`）不含 `__studio` 這個字串；CI 的 `check` job 跑它。
  - 目前（#6）CI 檢查的是 `__studioTest`：spike 頁的 `window.__studio` 還在正式 build 裡，#37 移除 spike 頁之後改成檢查 `__studio`。`__studioTest` 只在 `apps/web/src/testHook.ts`，以 `import.meta.env.VITE_E2E` 判斷，其他 build 裡是死碼，打包時整段移除。
- e2e 的所有操作都經由真的鍵盤與介面；`__studioTest` 只用來讀結果。
- **補充**（#6）：測試要的前置資料（例如另一個測試要用的團譜）可以直接打 API 建立（`e2e/pages.ts` 的 `createScore`，帶瀏覽器 context 的 cookie 與 Origin）；但這個測試要驗證的行為本身一定經由真的介面操作。
  - **補充**（#19）：還沒有介面或 API 可以建立的前置資料（帶 Editor、Viewer 成員的團譜，或超過 8 小節的團譜），由 server 自己的腳本直接寫進 e2e 資料庫（`apps/server/tests/scoreE2e.ts`，`e2e/pages.ts` 的 `seedScore`）。腳本只接受名稱以 `_e2e` 結尾的資料庫，而且只建立新的團譜，所以不會和 server 記憶體裡的文件衝突。#13 有了加入成員的頁面之後，成員本身的行為仍然要經由介面驗證。
- **補充**：e2e 從 DOM 判斷狀態，不靠掛鉤：譜面畫好時譜面元素帶 `data-ready="true"`；同步狀態看指示器的 `data-sync`（`synced`、`syncing`、`offline`），等到 `data-sync="synced"` 就表示本機輸入的內容已經送到伺服器（#19，[`views.md`](views.md) 第 10 節）；頁面錯誤用 Playwright 的 `pageerror` 與 console 事件收集，斷言為空。
- Playwright 的網頁 `webServer` 是 `pnpm build && pnpm preview`，帶 `VITE_E2E=1` 建置，而且一律不重用已經在跑的 preview（`apps/web/playwright.config.ts`，#6）。
- 視圖 `SpikeView.vue` 與 `window.__studio` 是量測用的鷹架，要被取代（`spike-report.md:361`）。

## 3. CI

| job | 內容 |
|---|---|
| `check` | `pnpm lint`、`pnpm typecheck`、`pnpm test`（Postgres、Redis 用 service containers）、`pnpm --filter @studio/web build`、正式 build 不含 `__studio` 的檢查 |
| `e2e`（Chromium） | 完整的 e2e |
| `e2e-firefox` | 一個打譜的 smoke test：登入、輸入一個格號、重新整理後內容還在 |
| `e2e-webkit` | 兩個 smoke test。**Read view**：開唯讀連結，看到譜面，播放器進入 paused 狀態；訪客走 ticket，不需要 cookie。**打譜**：同 Firefox 的打譜 smoke（登入、輸入一個格號、重新整理後內容還在），server 用不帶前綴的 cookie 啟動（[`security.md`](security.md) 第 1 節）；另外用 `addInitScript` 把 `navigator.platform` 設成 `MacIntel`，按 `Meta+Z` 復原一次，讓平台層的 macOS 組合在真的瀏覽器裡走過一次（[`keymap.md`](keymap.md) 第 1.3 節） |
| `recognizer` | 建置辨識服務的 Docker image，在裡面跑 pytest 與契約 fixture 的測試 |

- 完整的 e2e 只在 Chromium 跑。
- 瀏覽器支援：打譜是最新版的 Chromium 系（Chrome、Edge）、Firefox 與桌面 Safari（owner 在 2026-11-13 裁定）；Read view 另外支援 iOS Safari 與 Android Chrome。
- CI 的瀏覽器用 `playwright install --with-deps <瀏覽器>` 安裝（只在 CI；本機第一次要自己裝，見 `README.md`）。
- S2 的延遲門檻**不當** CI 的關卡：同一格的數字在兩次執行間差很多（headless 134／160 ms，headed 77／95 ms）。
- **補充**：e2e 監聽 `securitypolicyviolation` 事件並斷言為 0（[`security.md`](security.md) 第 7 節）。
- 送 PR 前：`pnpm lint && pnpm typecheck && pnpm test`；web 或 server 有改時加上 `pnpm --filter @studio/web test:e2e`。

## 4. 量測（不是 CI 的關卡）

- 保留 `measure` 套件（`pnpm --filter @studio/web measure`）。
- M1b、M2、M3 的結尾各有一張「重跑並回報」的票，結果寫進報告。範圍包含：
  - `docToJson` 加 zod 驗證與 `WeakMap` 快取之後的延遲；
  - Firefox 與 WebKit 的數字；
  - 技巧與 Flag 的成本；
  - 其他成員的修改同時湧進來時的延遲。
- 只有證明是瓶頸時，才把 Flag 改成增量計算。
- 目標仍是按鍵到畫面 p95：一個聲部 ≤ 80 ms，五個聲部 ≤ 150 ms（100 小節 × 5 聲部）。

## 5. 票裡必須執行的確認檢查

每一項寫進對應的票，結果寫進 PR。

| # | 檢查 | 怎麼做 | 失敗時 |
|---|---|---|---|
| 1 | Firefox 在 `http://localhost` 上接不接受 `__Host-` cookie | 跑 Firefox 的打譜 smoke test（登入、輸入一個格號、重新整理） | 測試環境用環境變數改用不帶前綴的 cookie 名稱（前身 `app/config.py` 的 `cookie_secure` 做法）；正式環境不變 |
| 2 | headless WebKit 的播放器能不能進入 ready、paused 狀態 | 跑 WebKit 的 Read view smoke test | 斷言改成「譜面畫好、播放器沒有錯誤」；聲音交給實機人工判定 |
| 3 | 焦點在 `tabindex` 元素時，剪貼簿事件會不會觸發 | 在 Chromium、Firefox、WebKit 各寫一個 e2e：焦點在譜面時按 `Ctrl+C`、`Ctrl+V`，斷言 `copy`、`paste` 事件有觸發（現在的焦點元素是 `SpikeView.vue:355` 的 `.scroller`）。Mac 上 Safari 的 `Cmd+C`、`Cmd+V` 是第 6 節第 8 項 | 把鍵盤焦點放在一個畫面外、內含被選取文字的 `<textarea>`；任何一個瀏覽器失敗，三個都改用這個做法。這張票擋住「Viewer 複製並貼進樂句編輯器」的 e2e |
| 4 | alphaTab 匯入匯出的 round-trip | M5 第一張匯入匯出的票：GP5、GP7、MusicXML 的樣本「匯入 → `ScoreJSON` → 投影 → 匯出 → 再匯入」，斷言支援範圍內的內容不變，不支援的列進匯入報告（[`import-export.md`](import-export.md)） | 修正對照；做不到的列進報告 |
| 5 | S2 重新量測 | 見第 4 節 | 只有證明是瓶頸才改成增量；在成員筆電上量是人工項目 |
| 6 | M3 的游標幾何 | M3 的第一張票：兩個譜表、第二條聲線的游標定位，做法同 S3，並和 alphaTab 回報的音符頭位置比對（這兩種情況都沒有試過，`spike-report.md:215`） | 修正 `geometry.ts` 的公式 |
| 7 | 刪除小節的復原行為 | vitest 鎖住「刪除當下的內容會回來、之後別人同時送到的不保證」，仿照 `packages/score-model/tests/coediting.test.ts` 的「undo takes back only what the member did」 | — |
| 8 | 聲道分配 | 用 `sound.test.ts` 的寫法，斷言 16 個聲部（其中 15 個非鼓）都拿到獨立的主聲道，鼓都在第 9 聲道 | — |
| 9 | alphaTab 標記不被遮蓋 | e2e 在捲動位置 0 時，斷言所有疊層與 `reservedRects()` 不相交；包含編輯視圖、Read view、窄螢幕、樂句預覽 | 移開疊層，不是遮住標記 |

## 6. 人工判定項目

每一項是一張 `ready-for-human` 票，都不擋其他票。

1. 打譜手感。
2. 播放的聲音：S5 播放中修改的預設是 (a) 還是 (b)；節拍器與預備拍的聲音；從游標小節開始播放時，預備拍是否用起點小節的拍號。
3. 實機的手機、平板版面：包含 iOS 第一次播放要在使用者的手勢裡啟動音訊；「能不能打譜」判定的誤判情況（例如 iPad 接觸控板）。
4. 真實照片的辨識品質，包含非六弦的 TAB，以及用手機直接拍照上傳（iPhone、Android 各一次：檔案格式被不被接受、直拍的照片有沒有轉正）。
5. 目視確認 alphaTab 的標記沒有被我們的疊層蓋住；e2e 的幾何斷言之外，仍保留這項人工檢查。
6. 在樂團成員實際的筆電上重量 S2。spike 只在一台 i9-9900K 桌機上量過（`spike-report.md:22,355`）。Mac 的成員另外用 WebKit 量一次。
7. 部署，以及在 karyl-chan bot 的 `/admin/services` 註冊 service。
8. 在 Windows、macOS 各實際試一次衝突的快捷鍵，有 Linux 的話也試：[`keymap.md`](keymap.md) 裡每個帶修飾鍵的組合、Mac 上要按 `Fn` 的功能鍵與 `Fn+←`、`Fn+→`、Mac 上 Safari 的 `Cmd+C`、`Cmd+V`、`Cmd+Z`，以及 Linux 版 Chrome 的 `Alt+1`、`Alt+2`。記錄動作有沒有生效、作業系統或瀏覽器有沒有另外做事。

## 7. 其他用測試鎖住的行為

- 遷移的兩面（[`schema.md`](schema.md) 第 10 節）。
- 讀取時容錯：每一種讀不懂的節點都產生 `invalidContent`，`docToJson` 不丟例外（[`schema.md`](schema.md) 第 11 節）。
- 兩人同時在同一小節的附加位置輸入，各自的拍點保持成段（[`commands.md`](commands.md) 第 2 節）。
- 放置與貼上小節段時，同時輸入的拍點留下來（[`commands.md`](commands.md) 5.7）。
- 伺服器主動斷線的每一種事件（[`accounts.md`](accounts.md) 第 9 節）；訪客收不到 awareness（[`collab.md`](collab.md) 第 5 節）。
- 樂句儲存的 409 兩種情況與 413（[`phrases.md`](phrases.md) 5.1）。
- karyl-chan 登入的每一種失敗（[`karyl-login.md`](karyl-login.md) 第 6 節）。
