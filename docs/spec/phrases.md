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

- 用 DOM 的 `copy`、`cut`、`paste` 事件，不用 async Clipboard API，所以不會跳權限提示。`Ctrl+C`、`Ctrl+X`、`Ctrl+V` 的 keydown 不呼叫 `preventDefault()`，讓瀏覽器觸發這些事件（[`keymap.md`](keymap.md)）。
- 寫入 `text/plain`，內容是前綴 `sheet-thief-studio/fragment@1` 加上片段的 JSON，所以能跨分頁、跨團譜、貼進樂句編輯器。**補充**：前綴與 JSON 之間是一個換行字元 `\n`。
- schema 有非加法的改動時，`@1` 升成 `@2`。
- 貼上時用 zod 驗證；沒有前綴、前綴的版本不認得、驗證失敗、或種類不合的內容，忽略並提示「剪貼簿裡沒有可以貼上的內容」（補充：種類不合時提示「只能貼進同一種聲部」）。
- 複製：拍點範圍產生拍點段，小節範圍產生小節段；沒有選取時不動。
- 剪下等於「複製加上一個清空的 Command」。Viewer 只能複製，不能剪下或貼上。
- **焦點元素要先用測試確認**：現在譜面的焦點元素是 `SpikeView.vue:355` 的 `.scroller`（`tabindex="0"`）。在 Chromium 與 Firefox 寫一個 e2e，焦點在譜面時按 `Ctrl+C`、`Ctrl+V`，斷言 `copy`、`paste` 事件有觸發。失敗時：把鍵盤焦點放在一個畫面外、內含被選取文字的 `<textarea>`。這張確認票擋住「Viewer 複製並貼進樂句編輯器」的 e2e（[`testing.md`](testing.md)）。

## 3. 建立樂句的三種途徑

1. **空白樂句**：在 `/phrases` 按「新增」，選聲部預設（[`commands.md`](commands.md) 第 10 節的預設表），在樂句編輯器裡打。**補充**：新的空白樂句是 4/4、1 個空小節，名稱「未命名樂句」。
2. **存成樂句**：在團譜裡選取**小節範圍**後「存成樂句」。任何成員都可以，包含 Viewer；訪客沒有帳號，所以不行。片段帶著那個聲部的 `kind`、`tuning`（fretted）、`staves`（pitched）、每個小節的拍號與所有聲線。**補充**：只有拍點範圍時，提示「請選取小節範圍」；預設名稱是「<團譜標題> 第 a–b 小節」，可以在存檔前修改。
3. **辨識**：見第 7 節與 [`recognizer.md`](recognizer.md)。

## 4. 樂句庫（`/phrases`）

- 一份平面列表，沒有資料夾或標籤，依更新時間由新到舊排序。
- 可以依種類篩選、依名稱搜尋；可以改名、刪除、複製一份。
- 「從圖片辨識」的入口在這頁。**補充**：還沒審核完的辨識，列在頁面上方的「待審核」區塊。
- 手機上能不能上傳圖片辨識，等 owner 裁定；暫定不能（[`README.md`](README.md) 的「等待 owner 裁定」）。

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
| `revision` | integer，每次寫入加 1 |
| `created_at`、`updated_at` | |

- `CONTEXT.md` 不新增 Revision 這個詞，它只是 API 的欄位名稱（和前身的做法相同，前身 `docs/ARCHITECTURE.md:39`）。

## 5. 樂句編輯器（`/phrases/:id`）

- 在一份本機、不共編的 `Y.Doc` 裡，用 `EditorSession` 編輯一份「只有一個聲部的團譜」；用同一套投影來畫和播，速度在本機固定 120。
- 存檔時轉成片段，載入時重新產生 id。
- 復原堆疊在本機，重新整理後清空。
- 鍵位與團譜的可編輯視圖相同；小節的插入、刪除、拍號在這裡只影響這個樂句（補充）。
- **補充**：調弦、譜號可以在樂句編輯器裡改（同聲部屬性的 Command）；`kind` 不能改。

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

## 7. 審核頁（`/recognitions/:id`）

- 辨識進行中：顯示進度（輪詢 `GET /api/recognitions/:id`，補充：每 2 秒一次）。失敗時依錯誤代碼顯示原因與建議（[`recognizer.md`](recognizer.md)）。
- 辨識成功後，審核頁就是「樂句編輯器開著辨識結果」，旁邊並排原圖，並列出略過的項目：裝飾音的數量、capo、讀不懂的調弦等。
- 讀不懂的調弦：用標準調弦，並在審核頁顯示警告；審核頁可以手動選調弦（[`commands.md`](commands.md) 第 10 節的選項）。
- 可以直接修改，**不自動儲存**；有修改時用 `beforeunload` 警告。
- 按「存成樂句」才寫進樂句庫，並刪掉原圖。**補充**：同時刪掉這筆辨識；存檔前可以改名稱（預設「辨識結果 <日期>」）。
- 按「捨棄」就刪掉那筆辨識與原圖。
- 原圖要經過權限檢查才能讀取，只有發起辨識的帳號可以。
- 辨識結果在伺服器保留最多 7 天（[`recognizer.md`](recognizer.md)）。
