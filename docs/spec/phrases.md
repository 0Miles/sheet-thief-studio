# 樂句、樂句庫、剪貼簿、樂句編輯器、審核頁

標「補充」的是 spec 撰寫者保守補上的細節。放置（Drop）與貼上的語意見 [`commands.md`](commands.md) 5.6、5.7。

## 1. Phrase fragment 的形狀

片段不帶任何 id。拍點的形狀同 [`schema.md`](schema.md) 第 6 節，只是沒有 `id`。

### 1.1 小節段（樂句的內容，也是剪貼簿的一種）

```ts
interface BarsFragment {
  kind: "fretted" | "percussion" | "pitched";
  tuning?: number[];                  // 只有 fretted，而且必帶
  staves?: { clef: Clef }[];          // pitched 必帶，含 clef
  bars: {
    timeSig: { numerator: number; denominator: number };
    voices: Record<string, BeatWithoutId[]>;   // "譜表:聲線" → 拍點
  }[];
}
```

- 不帶 tempo、反覆、段落、capo、調號。
- **補充**：`bars` 至少 1 個；聲線鍵的範圍規則同 [`schema.md`](schema.md) 第 5 節；percussion 不帶 `tuning` 也不帶 `staves`。
- **補充**（#53）：片段帶了不該有的欄位就驗證失敗，不是略過：片段的 `id`、`capo`、別的種類才有的 `tuning` 或 `staves`、另一種片段的 `bars` 或 `beats`；小節的 `id`、`tempo`、`keySig`、`repeatStart`、`repeatEnd`、`voltas`、`section`、`anacrusis`；拍點的 `id`。其他不認得的欄位照 [`schema.md`](schema.md) 第 9 節的規則忽略（解析後不保留），讓加法的改動不必把 `@1` 升成 `@2`。
- **補充**（#53）：拍點段的 fretted 也必帶 `tuning`，貼上時拿它比對弦數。zod schema 是 `score-model` 的 `barsFragmentSchema`、`beatsFragmentSchema`、`fragmentSchema`（`src/phrases.ts`），1 MB 的上限也在裡面檢查。
- **補充**（#53）：`score-model` 的純函式：`fragmentOfBars`（從 `ScoreJSON` 的一個聲部取出一段小節範圍）、`fragmentToScore`（片段轉成只有一個聲部的 `ScoreJSON`，所有 id 重新產生，形狀和 `docToJson` 的輸出相同；聲部名稱是空字串、`program` 是該種類的預設）、`scoreToFragment`（反過來，取出整份）、`blankFragment`（空白樂句）。

### 1.2 拍點段（只在剪貼簿）

```ts
interface BeatsFragment {
  kind: "fretted" | "percussion" | "pitched";
  tuning?: number[];                  // 只有 fretted
  beats: BeatWithoutId[];             // 同一條聲線上連續的拍點
}
```

- 兩種片段以有 `bars` 或有 `beats` 區分。
- 單一片段的 JSON 最大 1 MB。

## 2. 剪貼簿

- 用 DOM 的 `copy`、`cut`、`paste` 事件，不用 async Clipboard API，所以不會跳權限提示。`Mod+C`、`Mod+X`、`Mod+V`（Windows、Linux 是 `Ctrl`，macOS 是 `Cmd`）的 keydown 不呼叫 `preventDefault()`，讓瀏覽器觸發這些事件（[`keymap.md`](keymap.md)）。
- 寫入 `text/plain`，內容是前綴 `sheet-thief-studio/fragment@1` 加上片段的 JSON，所以能跨分頁、跨團譜、貼進樂句編輯器。**補充**：前綴與 JSON 之間是一個換行字元 `\n`。
- schema 有非加法的改動時，`@1` 升成 `@2`。
- 貼上時用 zod 驗證；沒有前綴、前綴的版本不認得、驗證失敗、或種類不合的內容，忽略並提示「剪貼簿裡沒有可以貼上的內容」（補充：種類不合時提示「只能貼進同一種聲部」）。
- 複製：拍點範圍產生拍點段，小節範圍產生小節段；沒有選取時不動。
- 剪下等於「複製加上一個清空的 Command」。Viewer 只能複製，不能剪下或貼上。
- **焦點元素要先用測試確認**：現在譜面的焦點元素是 `ScoreView.vue` 的 `[data-scroller]`（`tabindex="0"`）。在 Chromium、Firefox、WebKit 各寫一個 e2e，焦點在譜面時按 `Ctrl+C`、`Ctrl+V`，斷言 `copy`、`paste` 事件有觸發。失敗時：把鍵盤焦點放在一個畫面外、內含被選取文字的 `<textarea>`；任何一個瀏覽器失敗，三個都改用這個做法，只維持一種焦點元素（補充）。CI 的 WebKit 跑在 Linux 上，按的是 `Ctrl`；Mac 上 Safari 的 `Cmd+C`、`Cmd+V` 由人工判定確認（[`testing.md`](testing.md) 第 6 節第 8 項）。這張確認票擋住「Viewer 複製並貼進樂句編輯器」的 e2e（[`testing.md`](testing.md)）。
  - **補充**（#52 的結果）：三個瀏覽器都通過，焦點元素維持 `[data-scroller]`。事件在 Chromium、WebKit 送到 `[data-scroller]`，在 Firefox 送到 `<body>`，所以在 document 上聽 `copy`、`cut`、`paste`，只在 `document.activeElement` 是 `[data-scroller]` 時處理（[`testing.md`](testing.md) 第 5 節）。
- **補充**（#58）：頁面這一側在 `apps/web/src/clipboard.ts` 的 `listenToClipboard`，團譜的兩種編輯視圖與樂句編輯器共用（`apps/web/tests/clipboard.test.ts`）。焦點不在譜面（文字欄位、對話框）時不處理，交給瀏覽器。複製、剪下沒有東西可寫時（沒有選取、唯讀的剪下）不呼叫 `preventDefault()`，剪貼簿不變；貼上一律 `preventDefault()`。
  - 讀取：前綴之後的換行也接受 `\r\n`（Windows 的剪貼簿可能把 `\n` 改成 `\r\n`）。前綴前面不能有任何字元。前綴之後的文字超過 `MAX_FRAGMENT_BYTES` 個 UTF-16 單位（換成 UTF-8 至少同樣多位元組，一定超過 1 MB）時不 `JSON.parse`，直接當作沒有可以貼上的內容。名為 `__proto__` 的欄位：在音符、聲線這類 record 裡，整個片段驗證失敗（#78）；在物件上和其他不認得的欄位一樣略過，不碰 prototype。過深的值在 schema 讀的位置驗證失敗，在不認得的欄位上略過。
  - 拍點段只包含讀取讀得到的拍點（和畫出來的一樣）；拍點範圍裡沒有讀得到的拍點時，複製不動。小節段同「存成樂句」，用 `fragmentOfBars`。
  - 樂句編輯器裡也能複製、剪下、貼上；貼上小節段的規則同團譜（5.7），樂句的小節不夠時在尾端加上小節，拍號沿用前一個小節。
  - 提示沿用 #57 的狀態區：團譜的 `.score__status`（一直存在的 live region）裡的 `.score__notice`，以 `say` 先清空再寫入，同一句話再說一次也會被朗讀。樂句編輯器（`apps/web/src/components/PhraseEditor.vue`，#64；樂句頁與審核頁共用）的提示改成同樣的做法（`.phrase__status` 裡的 `.phrase__notice`）。

## 3. 建立樂句的三種途徑

1. **空白樂句**：在 `/phrases` 按「新增」，選聲部預設（[`commands.md`](commands.md) 第 10 節的預設表），在樂句編輯器裡打。**補充**：新的空白樂句是 4/4、1 個空小節，名稱「未命名樂句」。
2. **存成樂句**：在團譜裡選取**小節範圍**後「存成樂句」。任何成員都可以，包含 Viewer；訪客沒有帳號，所以不行。片段帶著那個聲部的 `kind`、`tuning`（fretted）、`staves`（pitched）、每個小節的拍號與所有聲線。**補充**：只有拍點範圍時，提示「請選取小節範圍」；預設名稱是「<團譜標題> 第 a–b 小節」，可以在存檔前修改。
   - **補充**（#55）：入口是兩種編輯視圖工具列上的「存成樂句」按鈕（Read view 沒有，所以訪客、以及不能打譜的裝置上的成員都沒有）。沒有選取或只有拍點範圍時按鈕停用：用 `aria-disabled` 而不是 `disabled`，按鈕留在 Tab 順序裡，`aria-describedby` 指向「請選取小節範圍」，按下不動作。按下時以當下的內容取出片段（`apps/web/src/savePhrase.ts` 的 `barsToSave`，用 `fragmentOfBars`），對話框開著時別人的修改不算進去；按鈕狀態與取出的片段都來自 session 最後回報的選取。存好後留在團譜，提示「已存成樂句「<名稱>」。」；那個聲部在那些小節裡有讀不懂而略過的內容（`invalidContent` Flag）時，提示改成「……；讀不懂的內容已經略過，沒有存進去。」。伺服器回的任何 413（片段超過 1 MB 的 `phrase_too_large`，或請求本體超過上限的 `payload_too_large`）都顯示「樂句太大。」（`saveRefusal`，同 `phraseSaver.ts`）。只有一個小節時預設名稱是「<團譜標題> 第 a 小節」；空白標題用「未命名」；太長時從標題的尾端以字素（`Intl.Segmenter`，ZWJ 組成的 emoji 不拆開）為單位截掉，讓名稱不超過 100 個 UTF-16 單位（和 `phraseName` 的 zod 計法相同；`defaultPhraseName`）。
3. **辨識**：見第 7 節與 [`recognizer.md`](recognizer.md)。

## 4. 樂句庫（`/phrases`）

- 一份平面列表，沒有資料夾或標籤，依更新時間由新到舊排序。
- 可以依種類篩選、依名稱搜尋；可以改名、刪除、複製一份。
- 「從圖片辨識」的入口在這頁。**補充**：還沒審核完的辨識，列在頁面上方的「待審核」區塊。
- 「從圖片辨識」用 `<input type="file" accept="image/*" multiple>`，**不設** `capture`：手機會讓使用者選擇直接拍照或從相簿挑（owner 在 2026-11-13 裁定手機可以上傳）。
- **補充**（#53）：搜尋是名稱裡的子字串、不分大小寫（Postgres 的 `ILIKE`），`%`、`_` 照字面比對；空白的搜尋等於沒有搜尋。新增空白樂句的對話框有名稱（預設「未命名樂句」）與聲部預設兩欄；建立後留在列表（樂句編輯器在之後的票）。刪除前先確認。
- 在不能打譜的裝置上（手機、平板；判定同 [`views.md`](views.md) 第 1 節的 `canType`），這一頁可以列出、篩選、搜尋樂句，也可以「從圖片辨識」。**補充**：新增空白樂句、改名、刪除、複製一份，只在能打譜的裝置上出現，維持「手機與平板只看譜與播放」的限制，只開放上傳這一項。上傳後照常進審核頁看進度，結果留在「待審核」區塊，到桌面再審核。

### 4.1 `phrases` 表

| 欄位 | 說明 |
|---|---|
| `id` | |
| `owner_id` | 擁有者帳號 |
| `name` | **補充**：1–100 字元 |
| `kind` | |
| `string_count` | fretted 的弦數；其他種類是 null |
| `staff_count` | **補充**：pitched 的譜表數，給側欄的相容判定用；其他種類是 null |
| `bar_count` | 小節數 |
| `content` | `jsonb`，小節段，最大 1 MB |
| `revision` | integer，每次寫入加 1。**補充**：建立時是 1，複製出來的樂句也從 1 開始 |
| `created_at`、`updated_at` | |

- `CONTEXT.md` 不新增 Revision 這個詞，它只是 API 的欄位名稱（和前身的做法相同，前身 `docs/ARCHITECTURE.md:39`）。

## 5. 樂句編輯器（`/phrases/:id`）

- 在一份本機、不共編的 `Y.Doc` 裡，用 `EditorSession` 編輯一份「只有一個聲部的團譜」；用同一套投影來畫和播，速度在本機固定 120。
- 存檔時轉成片段，載入時重新產生 id。
- 復原堆疊在本機，重新整理後清空。
- 鍵位與團譜的可編輯視圖相同；小節的插入、刪除、拍號在這裡只影響這個樂句（補充）。
- **補充**：調弦、譜號可以在樂句編輯器裡改（同聲部屬性的 Command）；`kind` 不能改。
- 在不能打譜的裝置上（[`views.md`](views.md) 第 1 節的 `canType`），樂句編輯器只能看：畫出樂句、可以播放，不接受修改，也不送出任何儲存請求。**補充**：顯示「請在電腦上編輯」。

### 5.1 儲存

- 停止修改 1 秒後自動儲存：`PUT` 整份片段，帶上 `baseRevision`；回應帶新的 `revision`。每次寫入 `revision` 加 1。
- 同一個分頁同時最多一個 `PUT` 在路上；期間的修改只記住最新內容，等前一個回來、更新 revision 之後再送。
- `baseRevision` 不符時伺服器回 409。客戶端先讀一次最新內容（`GET /api/phrases/:id`）：
  - 如果和本機要存的內容完全相同（例如回應在網路上丟了、重送造成的），直接採用伺服器的 revision，不提示。
  - 否則提示「這個樂句在別處被修改過」，讓使用者選「重新載入」或「另存成新樂句」。不做合併。
- 有未儲存的修改，或 `PUT` 還沒完成時，用 `beforeunload` 警告。
- 超過 1 MB 時伺服器回 413，介面顯示「樂句太大」，並保留本機內容。
- **補充**：「完全相同」以「鍵依字母排序後的 JSON 字串相同」判斷。
- **補充**：改名（`PATCH`）同樣帶 `baseRevision`、同樣讓 `revision` 加 1、同樣的 409 處理；比較內容時連名稱一起比。
- **補充**（#54）：存檔與排隊在 `apps/web/src/phraseSaver.ts`（`createPhraseSaver`，vitest 用假的 `fetch` 與假時鐘測）。409 拿「送出的那一份」，以及從同一個 revision 送出、回應沒回來（連不上或 5xx）的每一份（名稱與片段），和讀回來的內容比，兩邊都先經過 `barsFragmentSchema`；任何一份相同就採用伺服器的 revision，不提示，再送本機最新的內容。409 之後讀不到最新內容時，顯示「無法確認這個樂句是否在別處被修改過」，不自動重送，由使用者按「再試一次」重新讀取。連不上伺服器、5xx、429 時用同一個 `baseRevision` 自動重送：等 5 秒、之後每次加倍，最多 1 分鐘，最多 5 次；429 照 `Retry-After`（「回應在網路上丟了」的 409 就是這樣來的）。其他被拒的情況、或重送用完次數，不自動重送，下一次修改或按「再試一次」再送。在 app 內換頁時，等待中的修改先立刻送出，送完才離開；送不出去（衝突、太大、連不上）時先問要不要離開。關閉或重新整理頁面時同樣立刻送出，並由 `beforeunload` 警告。樂句編輯器裡也能改名，按下就送，排在還沒送的片段之後。「另存成新樂句」的名稱預設是目前的名稱，可以修改，存好後打開新的樂句；「重新載入」丟掉本機的修改，重新讀一次。
- **補充**（#54）：樂句編輯器的小節屬性面板只有拍號，聲部面板只有調弦（fretted）與譜號（pitched）；不顯示 Flag 與混音器。

## 6. 編輯視圖裡的樂句側欄

只有可編輯視圖有；唯讀編輯視圖和 Read view 都沒有。開關的鍵見 [`keymap.md`](keymap.md)。

- 列出自己的樂句，預設只顯示相容的樂句，可以搜尋。**補充**：可以切換「顯示全部」。
- 「相容」的定義（相對於游標所在的聲部）：kind 相同；fretted 的樂句弦數不超過目標聲部；pitched 的樂句譜表數不超過目標聲部。
- 點一下，在 popover 裡顯示預覽：
  - 所有預覽共用一個 renderer 實例：可以用 worker；`soundFont: null`，也就是關掉播放器（`alphaTabEngine.ts:95-96`）。
  - 預覽用 Page 版面，依寬度換行，垂直捲動。**不能**用固定大小加 `overflow: hidden` 把譜裁掉。理由：只要整份譜超過 10 小節就會出現 alphaTab 的標記，即使只畫其中幾個小節也一樣（`spike-report.md:66`）。
  - `reservedRects` 同樣適用。
- 放置：拖到小節上放下，或按鍵放到游標所在的小節。拖曳時的目標由 `hitTest` 決定（`geometry.ts:91-129` 的 `cursorAtPoint`，由 `alphaTabEngine.ts:162` 呼叫）；種類不合的聲部，高亮成「不能放」。
- 放置的語意見 [`commands.md`](commands.md) 5.7。
- 側欄不做辨識。
- **補充**（#57）：寫法。
  - 側欄是 `apps/web/src/components/PhraseSidebar.vue`，放在譜面旁邊，和小節屬性面板、聲部面板、混音器同一時間只開一個。打開時重新讀 `GET /api/phrases`（搜尋同 `/phrases`，打字停 200 ms 後送），焦點進搜尋框；`Esc` 先關預覽，沒有預覽時關側欄；`F4` 關側欄；關掉後焦點回到譜面。四個側邊面板是同一個列舉（`ScoreView.vue` 的 `SidePanel`），同時只有一個。
  - 預覽是 `role="dialog"`：點樂句打開時焦點移進預覽，關閉（`Esc`、「關閉預覽」、再點一次樂句）時回到打開它的樂句。`Enter` 只在兩處放置：焦點在列表的樂句上，或焦點在預覽裡（不在預覽的按鈕上）。側欄自己的按鈕、連結與輸入框（`button`、`a`、`input`、`select`、`textarea`、`[data-no-drop]`）的 `Enter` 照它們自己的作用，不放置。列表顯示的樂句資訊和樂句庫共用 `strings.phrases.details`。
  - 相容與拖曳目標的判定是 `apps/web/src/phraseSidebar.ts` 的純函式（vitest）：`fitsPart`（樂句庫列表的 `stringCount`、`staffCount` 對聲部的弦數與譜表數）、`phrasesShown`（沒有游標時列出全部）、`dropSpotOf`。
  - 預覽的 popover 開在側欄自己的欄位裡，不疊在譜面上，所以不會蓋住譜面的保留區域。預覽裡畫出樂句的小節框（`structureBoxesOf`，避開預覽自己的保留區域），並放上 `data-reserved`。預覽的捲動區最高 50vh、`overflow: auto`；縮放 0.75。renderer 在第一次預覽時建立，側欄關閉時不銷毀（側欄以 `v-show` 隱藏），離開譜頁才銷毀。
  - 樂句內容（`GET /api/phrases/:id`）依 `id` 與 `revision` 快取，讀不到的下次重讀。
  - 拖曳用 HTML5 drag and drop：`dragover` 時以 `hitTest` 找小節，`dropSpotOf` 算出要取代的小節（譜裡有的那些）；種類相同時畫成可以放（`data-drop="ok"`），種類不同時只畫游標下那個小節、標成「不能放」（`data-drop="refused"`、`data-drop-label`），不接受放下。弦數、譜表數等其他拒絕由 `dropFragment` 判斷，放下後以提示告知。
  - 放置走 `EditorSession.drop(target, fragment)`：一個 Command、一個復原步驟；唯讀時拒絕（同其他會改動文件的鍵）；游標以 `settleCursor` 留在原處（原本的拍點被取代時移到最近的位置），選取結束。拖曳放下後焦點回到譜面，`Ctrl+Z` 直接復原。
  - 放置的提示（`DropHint`）與拒絕（`DropRefusal`）顯示在譜頁工具列的提示（`role="status"`），**不是** issue #57 寫的 toast。理由：app 沒有掛 `@karyl-chan/ui` 的 `AppToast`；工具列的提示在譜面上方，不疊在譜面上，所以不會蓋到保留區域；session 的其他提示也在這裡。這個 `role="status"` 容器（`.score__status`）一直在頁面上，只換裡面的內容；提示本身（`.score__notice`）只在有提示時才在容器裡，所以「沒有提示」仍是沒有這個元素（#109 的 `readOnly.spec.ts` 這樣判斷）；放置的提示先清空再寫入，所以連續兩次相同的提示，螢幕閱讀器也會再念一次；成功而沒有提示的放置會清掉上一次的提示。文字在 `strings.score.phraseSidebar`。

## 7. 審核頁（`/recognitions/:id`）

- 辨識進行中：顯示進度（輪詢 `GET /api/recognitions/:id`，補充：每 2 秒一次）。失敗時依錯誤代碼顯示原因與建議（[`recognizer.md`](recognizer.md)）。
- 辨識成功後，審核頁就是「樂句編輯器開著辨識結果」，旁邊並排原圖，並列出略過的項目：裝飾音的數量、capo、讀不懂的調弦等。
- 讀不懂的調弦：用標準調弦，並在審核頁顯示警告；審核頁可以手動選調弦（[`commands.md`](commands.md) 第 10 節的選項）。
- 可以直接修改，**不自動儲存**；有修改時用 `beforeunload` 警告。
- 按「存成樂句」才寫進樂句庫，並刪掉原圖。**補充**：同時刪掉這筆辨識；存檔前可以改名稱（預設「辨識結果 <日期>」）。
- 按「捨棄」就刪掉那筆辨識與原圖。
- 原圖要經過權限檢查才能讀取，只有發起辨識的帳號可以。
- 辨識結果在伺服器保留最多 7 天（[`recognizer.md`](recognizer.md)）。
- 在不能打譜的裝置上，審核頁只能看：進度、失敗的原因與建議、辨識結果的譜（可以播放）、原圖、略過的項目都看得到；不能修改，也沒有「存成樂句」與「捨棄」。**補充**：顯示「請在電腦上審核並存成樂句」；捨棄也是改動，所以一樣留給桌面。
- **補充**（#64）實作的細節：
  - 樂句編輯器本身是 `apps/web/src/components/PhraseEditor.vue`（畫、播、打譜、小節與聲部面板；每次修改以整份片段送出 `change`），`/phrases/:id`（`PhraseView.vue`，自動儲存）與審核頁（`RecognitionView.vue`，不自動儲存）各自決定怎麼處理修改。
  - 輪詢、失敗的文字、調弦的提示、上傳的表單與被拒時的文字在 `apps/web/src/recognition.ts`（vitest）。輪詢在 `running` 以外的狀態停止；連不上時照樣 2 秒後再問，404 時停止並顯示找不到頁面。
  - 讀不懂的調弦（`tuning.reason` 是 `unrecognized`）顯示警告與原文，「選擇調弦」打開樂句編輯器的聲部面板（第 5 節的調弦選項，含逐弦自訂）；沒讀到調弦（`not_found`）只顯示一行說明，不是警告。
  - 旁邊依序列出略過的項目、辨識服務的提醒（`warnings`）與原圖；手機上這一欄移到譜的下面。辨識中或失敗時也顯示原圖。
  - 失敗的辨識在桌面上也可以「捨棄」；沒有「存成樂句」。
  - 存檔前的名稱預設是「辨識結果 YYYY-MM-DD」，日期是這筆辨識建立的那天（瀏覽器的時區）。存成樂句或捨棄後回到 `/phrases`。
  - 有修改時，在 app 內換頁也先問要不要離開（`beforeunload` 之外）；辨識結果本身照舊留在伺服器。
  - `/phrases` 的「從圖片辨識」是按鈕加上看不見的 `<input type="file">`；一次選超過 15 張時不送出，直接提示。上傳被拒時：415 說是第幾張、413 說大小上限；400 看 `params.issues`：`images` 的 `too_big` 說張數上限、`too_small` 說至少要一張，沒有指出欄位（伺服器讀不了這個 body）時說無法讀取上傳的檔案；其他照錯誤代碼。離開前的確認與 `beforeunload` 由 `apps/web/src/leaving.ts` 提供，樂句編輯器的頁面與審核頁共用。「待審核」區塊列出每一筆的狀態、建立時間與張數，點下去打開審核頁。
