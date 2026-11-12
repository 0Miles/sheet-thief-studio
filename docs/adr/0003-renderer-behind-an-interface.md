# 譜面引擎用 alphaTab，但只在 `score-render` 裡出現

修訂：2026-11-13，依 M0 技術驗證（`docs/spike-report.md` 的 S1、S2、S5，以及「意外，以及和 ADR 不一致的地方」一節）。原文的兩句話被量測推翻，改了什麼列在文末。

顯示和播放用 alphaTab：它是唯一同時有 Guitar Pro 等級的 TAB、鼓譜、五線譜和內建合成器的開源方案；VexFlow、OSMD、Verovio 都要自己補排版、TAB 或播放。

alphaTab 有兩個讓我們不想被它綁住的地方。第一，它沒有官方的編輯 API：只能改它的模型再重排，1.9 起可以只重排改到的那一行之後。第二，授權正在變動：1.9 起譜面上會顯示它的標記；之後的版本會換成帶署名條款的授權，而且把「透過網路提供服務」也算成散布。所以：

- 團譜的資料格式是我們自己的 schema（ADR 0002），不是 alphaTab 的模型，也不是 alphaTex。
- alphaTab 只在 `packages/score-render` 裡 import。其他程式只認得 `ScoreRenderer`（畫譜、座標查詢）和 `ScorePlayer`（播放）兩個介面。唯一的例外是 `apps/web/vite.config.ts` 裡的 `@coderline/alphatab-vite`：它是建置工具，負責打包 worker、複製字型與音色庫。ESLint 擋住其他地方 import `@coderline/alphatab`，`packages/score-editor` 也在名單裡。
- 團譜到 alphaTab 模型是單向的投影；游標、選取、編輯指令都以團譜的 id 定址，不依賴 alphaTab 的物件。
- **以小節為單位就地更新。** 改到的小節在既有的 alphaTab 模型裡換掉（`replaceBars`），並帶 `RenderHints.firstChangedMasterBar`。alphaTab 看到的一直是同一份 `Score`，所以不會每按一次鍵就自己重新產生聲音、停止播放。小節、聲部或聲線數有變動時，才整份重新投影。
- **版面用 Page，開著 `core.enableLazyLoading`。** 少了任何一個，`firstChangedMasterBar` 就無效，會退回整份重排。
- **兩種編輯視圖不用 worker**（`core.useWorkers = false`）。Read view 與樂句預覽可以用 worker。
- **版本鎖在精確的 1.9.0。** `@coderline/alphatab`（`packages/score-render/package.json`）與 `@coderline/alphatab-vite`（`apps/web/package.json`）同版，都是 MPL-2.0。agent 不得自行升版；升版要開 `ready-for-human` 票，並重跑 S1 與 S3，因為游標幾何依賴 alphaTab 沒有保證的內部行為（`BarBounds` 的上緣就是第一條譜線）。
- **標記不得被遮住。** `ScoreRenderer.reservedRects(): Rect[]` 回傳疊層不得覆蓋的區域，也就是第一行譜最後一個小節上方、標記所在的位置；名稱不提 alphaTab。游標、名牌、選取框、Flag 框、預覽、固定的播放列都不得畫進這些區域。

考慮過、沒採用的做法：

- **每次編輯整份重新投影，交給 alphaTab 預設的 worker 排版（原本的寫法）。** S2 量到按鍵到畫面的 p95，一個聲部 76–98 ms、五個聲部 77–160 ms，卡在 80／150 ms 的門檻上，而且每次跑差很多；每次換新的 `Score` 還會讓播放停下來。就地換小節、不用 worker 時是 44／67 ms，餘裕約一倍。
- **只畫游標附近 16 個小節。** 不用 worker 時 100 × 5 在 6 ms 以內，但捲動要自己做，視窗一移動就整個重排。留作備案：譜比 100 × 5 大很多，或成員的機器慢很多時再開。
- **自己畫編輯視圖。** 目前的數字看不出需要。
- **固定在沒有標記的 1.8.4。** 標記可以接受，而 1.9 的部分重排正是編輯視圖需要的。

## Consequences

- 打譜層（游標、鍵盤輸入、選取）全部自己做，alphaTab 只負責畫和播。
- 不用 worker 時，排版會卡住網頁的執行緒：五個聲部改第 3 小節約 27 ms，第一次畫整份譜約 200–230 ms。譜比 100 × 5 大很多時要重新量。
- `replaceBars` 要自己接好小節之間的鏈結（前後拍點、連結線）；每加一種技巧，都要確認就地換小節後仍然正確。
- alphaTab 自己的捲動關掉了，播放時的跟隨由殼來做，所以 `ScoreRenderer` 有一個「由播放位置（tick）查座標」的方法。
- 平台自用，譜面上有標記可以接受；不以違反授權的方式移除、隱藏、遮住或裁掉它。標記和譜線畫在同一條 path 裡，沒有自己的 DOM 元素，所以 e2e 只能在捲動位置 0 時斷言疊層和 `reservedRects()` 不相交；目視確認仍是人工項目。
- 若日後授權變得不能接受，就固定在 1.9.0（MPL-2.0），或在介面後面換掉引擎。

## 修訂了什麼

| 原文 | 現在 | 依據 |
|---|---|---|
| 「只能直接改它的模型再整份重排」 | 1.9 有公開的 `RenderHints.firstChangedMasterBar`，可以只重排改到的那一行之後 | `spike-report.md` 的 ADR 0003 一節 |
| 「每次編輯都要重新投影並重排；延遲是否可接受由 M0 的量測決定」 | 以小節為單位就地更新；編輯視圖不用 worker；Page 版面加 lazy loading | S2、S5 |
| 沒有提 worker | 編輯視圖關掉，Read view 與預覽可以用 | S2 |
| 沒有提版本 | 兩個套件鎖在精確的 1.9.0，升版要人工 | S1、S3 |
| 「alphaTab 只在 `score-render` 裡 import」 | 加上唯一的例外 `@coderline/alphatab-vite` | `spike-report.md` 的 ADR 0003 一節 |
| 只說標記可以接受 | 加上 `reservedRects()` 與不相交的斷言 | S1 |
