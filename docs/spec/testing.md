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
- **補充**（#31）：`packages/score-render/tests/engine.test.ts` 測播放器在重新產生聲音前後的行為（[`playback.md`](playback.md) 4.1）。瀏覽器裡碰不到那十幾毫秒，所以把 alphaTab 的 `AlphaTabApi` 換成替身（`vi.mock`），其他都是 alphaTab 自己的：設定、模型、投影，以及用 `MidiFileGenerator` 建的 tick lookup。替身不會自己回報任何事；worker 的回報由測試照 alphaTab 1.9 的順序送出（位置 0、paused、ready、midiLoaded、ready、位置 0），替身的 `playerState`、`tickPosition` 也只在這些回報時改變，和 alphaTab 的快取一樣。範圍只到引擎怎麼回應這些回報；alphaTab 實際的順序、聲音本身與跟隨仍由 Playwright e2e 與人工試聽確認。升 alphaTab 版本時要重新核對這個順序。
- **補充**：`compose.dev.yaml` 的 Postgres 與 Redis 是 M1a 第一張 server 票建立的；伺服器測試用獨立的資料庫名稱，每個測試檔自己清資料。
  - **補充**（#114）：遷移只在 vitest 的 `globalSetup`（`apps/server/tests/globalSetup.ts`）跑一次，每個測試檔開頭用 `TRUNCATE ... RESTART IDENTITY CASCADE` 清空（`tests/support.ts` 的 `freshDatabase`），不再每檔重建 schema（CPU 忙碌時重建會超過 hook 的 10 秒上限）。測試檔共用一個資料庫與一個 Redis database，所以 server 的測試檔依序執行（`fileParallelism: false`）。`migrations.test.ts` 在自己的資料庫（`<測試資料庫>_migrations`，跑完刪掉）從零遷移，不影響其他檔。等待「之後不會再寫入」的測試用 fake timer 推過去，不用真的 sleep。

## 2. 測試掛鉤與 build

取代 M0 的 `window.__studio`（spike 頁的掛鉤，#37 移除）：

| 掛鉤 | 何時存在 | 內容 |
|---|---|---|
| `window.__studioTest` | 只在 `VITE_E2E=1` 的 build | 只有三個唯讀函式：`scoreJson()`、`cursor()`、`flags()`。**補充**（#35）：`scoreJson()` 是這一頁手上的文件，從第一次同步、譜開始畫起就有，離線時打的也在裡面；之前是 null。**補充**（#33）：加上第四個 `player()`，是播放器實際用的設定（`ScorePlayer.settings()`：速度、節拍器、預備拍、循環、各聲部的混音），e2e 用它確認存下的設定在重新整理後真的交給了播放器。**補充**（#102）：加上唯一會寫入的 `writeMeta(field, json)`：繞過指令，把 JSON 直接寫進這一頁文件的 `meta`，模擬舊版分頁或離線資料手上的值（巢狀超過 `MAX_VALUE_DEPTH` 的值沒有任何指令或按鍵寫得出來）；只有 `e2e/depth.spec.ts` 用 |
| `window.__studioMeasure` | 只在 `VITE_MEASURE=1` 的 build | 只給 measure 套件用：`placeCursor`、`editBar`、`bulkEdit`、`renders`、`keys`、`player.reload`、`player.trace`，以及 measure 套件讀的 `ready`、`synced`、`json`、`stateSize`、`cursorRect`、`noteHeads`（游標所在拍點的音符頭，alphaTab 回報的位置，給游標幾何檢查用）、`errors`、`player.state`、`player.position`（補充）。在 `apps/web/src/measureHook.ts`，掛在編輯視圖上 |

- 正式 build 兩者都沒有。加一個檢查，確認打包結果（`apps/web/dist`）不含 `__studio` 這個字串；CI 的 `check` job 跑它。
  - `__studioTest` 只在 `apps/web/src/testHook.ts`，以 `import.meta.env.VITE_E2E` 判斷；`__studioMeasure` 只在 `apps/web/src/measureHook.ts`，以 `import.meta.env.VITE_MEASURE` 判斷。其他 build 裡兩者都是死碼，打包時整段移除。CI 的檢查用 `grep -rq "__studio" apps/web/dist`（#37；#6 到 #37 之間檢查的是 `__studioTest`，因為 spike 頁的 `window.__studio` 還在正式 build 裡）。
- e2e 的所有操作都經由真的鍵盤與介面；`__studioTest` 只用來讀結果（例外是上表的 `writeMeta`，只用來放進介面做不出來的前置資料）。
- **補充**（#6）：測試要的前置資料（例如另一個測試要用的團譜）可以直接打 API 建立（`e2e/pages.ts` 的 `createScore`，帶瀏覽器 context 的 cookie 與 Origin）；但這個測試要驗證的行為本身一定經由真的介面操作。
  - **補充**（#19）：還沒有介面或 API 可以建立的前置資料（帶 Editor、Viewer 成員的團譜、超過 8 小節的團譜，或多聲部的團譜），由 server 自己的腳本直接寫進 e2e 資料庫（`apps/server/tests/scoreE2e.ts`，`e2e/pages.ts` 的 `seedScore`）。腳本只接受名稱以 `_e2e` 結尾的資料庫，而且只建立新的團譜，所以不會和 server 記憶體裡的文件衝突。#13 有了加入成員的頁面之後，成員本身的行為仍然要經由介面驗證。
  - **補充**（#7）：會被測試用掉的帳號（例如要改掉暫時密碼的帳號）不放進 `e2e/environment.ts` 的固定帳號，由測試自己用 `apps/server/tests/accountE2e.ts`（`e2e/pages.ts` 的 `seedAccount`）建立一個名稱帶亂數的新帳號，所以同一個測試可以重跑，也可以在別的瀏覽器 project 再跑一次。
- **補充**：e2e 從 DOM 判斷狀態，不靠掛鉤：譜面畫好時譜面元素帶 `data-ready="true"`；視圖與版面看 `<main>` 的 `data-view`（`editable`、`readOnlyEdit`、`read`）與 `data-layout`（`narrow`、`wide`），要求畫出的聲部看譜面元素的 `data-parts`（聲部 id，逗號分隔，#32）；同步狀態看指示器的 `data-sync`（`synced`、`syncing`、`offline`），等到 `data-sync="synced"` 就表示本機輸入的內容已經送到伺服器（#19，[`views.md`](views.md) 第 10 節）；頁面錯誤用 Playwright 的 `pageerror` 與 console 事件收集，斷言為空。
- Playwright 的網頁 `webServer` 是 `pnpm build && pnpm preview`，帶 `VITE_E2E=1` 建置，而且一律不重用已經在跑的 preview（`apps/web/playwright.config.ts`，#6）。
- M0 的 `SpikeView.vue`、`/spike/:name`、`/local` 與 `window.__studio` 已在 #37 移除；量測改對編輯視圖（第 4 節）。

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
- **補充**（#38）：smoke test 在 `apps/web/e2e/smoke/`，由 Playwright project `firefox`（`typing.spec.ts`）與 `webkit`（`typing.spec.ts`、`read.spec.ts`、`mac.spec.ts`）執行，`chromium` project 不跑。WebKit 的 project 改向第三個 server（port 8033，`WEB_ROOT` 指向剛建好的 `dist`，`INSECURE_COOKIES=1`）取網頁與登入，所以同一次 `pnpm --filter @studio/web test:e2e` 裡 Chromium 與 Firefox 仍用 `__Host-` cookie。CI 的 `e2e`、`e2e-firefox`、`e2e-webkit` 是同一個 job 的 matrix，各自用 `--project` 只跑自己的 project、只安裝自己的瀏覽器；`~/.cache/ms-playwright` 以 Playwright 版本為鍵快取，系統套件每次由 `--with-deps` 安裝。
  - Windows 上的 Playwright WebKit 沒有 Web Audio（`AudioContext` 不存在），alphaTab 的播放器只會記錯誤、進不了 paused，所以 WebKit 的 smoke 在 Windows 本機跳過，以 CI（Linux）的結果為準（#129）。
- S2 的延遲門檻**不當** CI 的關卡：同一格的數字在兩次執行間差很多（headless 134／160 ms，headed 77／95 ms）。
- **補充**：e2e 監聽 `securitypolicyviolation` 事件並斷言為 0（[`security.md`](security.md) 第 7 節）。
  - **補充**（#18）：每個 spec 的 `test` 從 `e2e/test.ts` import，不直接從 `@playwright/test`；它對測試開的每個 browser context 監聽這個事件，測試結束時斷言沒有違規。worker 裡的違規不會送到頁面的事件，Playwright 的 worker console 也收不到；在 Chromium 上改聽 CDP 的 `Log.entryAdded`（`source: "worker"`），它記下被擋的請求（`connect-src` 等），但不記被擋的 eval，所以 worker 裡的 eval 違規目前聽不到（已知限制）。
  - **補充**（#18）：`vite preview` 不送 CSP，所以另有一個 Playwright project `served`：第二個 server（port 8032，`WEB_ROOT` 指向剛建好的 `dist`）自己提供網頁並帶 CSP，只跑 `e2e/served.spec.ts`：登入、開一份團譜、畫出譜面、音色載入完成，再打開樂句庫、帳號設定、後台、團譜設定，以及在沒登入的 context 開唯讀連結（畫出譜面、音色載入完成），全程沒有違規；最後確認行內 script 與 worker 裡連別的 host 真的被擋、而且聽得到。`pnpm --filter @studio/web test:e2e` 會一起跑。
- 送 PR 前：`pnpm lint && pnpm typecheck && pnpm test`；web 或 server 有改時加上 `pnpm --filter @studio/web test:e2e`。

## 4. 量測（不是 CI 的關卡）

- 保留 `measure` 套件（`pnpm --filter @studio/web measure`）。它對編輯視圖量：`playwright.measure.config.ts` 用 `VITE_MEASURE=1` 建置網頁，server 與資料庫和 e2e 相同。
  - **補充**（#37）：量測用的團譜（100 小節 × 5 聲部的種子譜、S1／S3／S6 的示範譜）在測試裡建好 `Y.Doc`，以 Yjs update 交給 server 的 `apps/server/tests/scoreE2e.ts`（`seedScore` 的 `state`），寫進 e2e 資料庫，擁有者是 admin（`e2e/measure/scores.ts`）。網頁的任何 build 都沒有量測專用的路由或 API。
  - 只顯示一個聲部用成員自己的顯示選項（存在瀏覽器的 `localStorage`，`src/display.ts`），和成員實際的做法相同。
  - 數字寫到 `docs/measurements/data/`，截圖寫到 `docs/measurements/`；M0 的結果留在 `docs/spike/`。`MEASURE_RUNS=3` 把每項量測縮短，只用來確認套件能跑。
  - **補充**（#39）：瀏覽器用 `--project` 選（`chromium`、`firefox`、`webkit`）。`chromium` 跑全部量測，`firefox` 與 `webkit` 只跑 S2；WebKit 和 smoke 一樣從 8033 的 `INSECURE_COOKIES=1` server 取頁面。資料檔名帶瀏覽器（`s2-keys-firefox-headless.json`），報告寫在 `docs/measurements.md`，每個里程碑一節。
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
| 3 | 焦點在 `tabindex` 元素時，剪貼簿事件會不會觸發 | 在 Chromium、Firefox、WebKit 各寫一個 e2e：焦點在譜面時按 `Ctrl+C`、`Ctrl+V`，斷言 `copy`、`paste` 事件有觸發（現在的焦點元素是 `ScoreView.vue` 的 `[data-scroller]`）。Mac 上 Safari 的 `Cmd+C`、`Cmd+V` 是第 6 節第 8 項 | 把鍵盤焦點放在一個畫面外、內含被選取文字的 `<textarea>`；任何一個瀏覽器失敗，三個都改用這個做法。這張票擋住「Viewer 複製並貼進樂句編輯器」的 e2e |
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
