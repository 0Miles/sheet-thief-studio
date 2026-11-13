# 視圖、顯示、Presence、手機版面

`/scores/:id` 與 `/s/:token` 給出哪一種視圖、每種視圖能做什麼、其他成員的游標怎麼畫。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 三種視圖與判定函式

視圖由 `packages/score-editor` 裡的**一個純函式**決定，用 vitest 窮舉所有組合。

```ts
type Role = "owner" | "editor" | "viewer";
type View = "editable" | "readOnlyEdit" | "read";

function decideView(input: { role: Role | null; isGuest: boolean; canType: boolean }): View;
```

- `isGuest` 為真時，`role` 是 `null`。
- `canType`（能打譜）：`matchMedia("(pointer: fine)").matches` 而且視窗寬度至少 1024 px。
- **補充**：只在載入頁面時判定一次；之後改變視窗大小不切換視圖（避免打到一半失去選取），只有重新整理才會重新判定。
- 判定不看瀏覽器：桌面 Safari 和 Chrome、Edge、Firefox 一樣可以打譜（[`testing.md`](testing.md) 第 3 節）。
- 同一個 `canType` 也決定樂句編輯器與審核頁能不能修改（[`phrases.md`](phrases.md) 第 5、7 節）。

| 視圖 | 給誰 | 排版 |
|---|---|---|
| **可編輯視圖** | 在能打譜的裝置上的 Owner、Editor | 不用 worker |
| **唯讀編輯視圖** | 在能打譜的裝置上的 Viewer | 不用 worker |
| **Read view（看譜檢視）** | 訪客；以及在不能打譜的裝置上的任何角色 | 用 worker（`spike-report.md:334`） |

窮舉表（`decideView` 的測試照這張表寫）：

| `isGuest` | `role` | `canType` | 結果 |
|---|---|---|---|
| 是 | `null` | 是／否 | `read` |
| 否 | `owner`、`editor` | 是 | `editable` |
| 否 | `viewer` | 是 | `readOnlyEdit` |
| 否 | 任何 | 否 | `read` |

## 2. 兩種編輯視圖共通

- 點譜面只移動 Cursor，不移動播放位置：設定 `enableSeekToClick = false` 與 `enablePlaybackRangeSelection = false`（`alphaTab.d.ts:14309,14316`；`enableUserInteraction` 已經 deprecated，:14295）。
- 播放從 Cursor 所在小節開始；有 Selection 時，用選取範圍當循環區間（[`playback.md`](playback.md)）。
- 自動跟隨播放位置：成員按任何鍵或手動捲動時暫停，直到下一次按播放。
- alphaTab 的捲動已經關掉（`alphaTabEngine.ts:100`），跟隨由殼自己做，所以 `ScoreRenderer` 要新增「由播放位置（tick）查座標」的方法。
- 排版：Page 版面、lazy loading、`useWorkers: false`、以小節為單位就地更新（ADR 0003）。

## 3. 可編輯視圖

- 所有 Command（[`commands.md`](commands.md)）、剪貼簿的複製、剪下、貼上。
- 樂句側欄（只有這個視圖有，見 [`phrases.md`](phrases.md)）。
- 小節屬性面板。
- 聲部管理（新增、刪除、排序、屬性）與改標題、演出者。

## 4. 唯讀編輯視圖

- 可以：移動游標、選取、複製、存成樂句、從游標處播放、用選取範圍循環。
- 任何會改動文件的 Command 都由 `EditorSession` 拒絕；第一次按到時提示「檢視者無法修改」，之後不再提示。
- 沒有樂句側欄，不能剪下或貼上。
- 伺服器本來就會丟棄 Viewer 的更新（readOnly 連線），所以這只是介面層的保護。
- Presence 的 `mode` 是 `"read"`，游標用淡色畫。

## 5. Read view（看譜檢視）

- 點譜面就跳到那裡播放。**補充**：點擊只移動播放位置；正在播放就從那裡接著播，暫停中則停在新位置，等按播放才開始（避免一點譜面就突然出聲；iOS 也要在使用者的手勢裡啟動音訊）。在這個視圖裡 `enableSeekToClick` 是 `true`。
- 沒有 Selection、沒有 Cursor。
- 播放時一直自動跟隨。
- 用 worker 排版。
- 成員在 Read view 裡：Presence 的 `mode` 是 `"read"`、`cursor` 是 `null`，出現在成員列表上。
- 訪客在 Read view 裡：不出現在 Presence，也看不到 Presence；沒有匯出按鈕。這只是介面上的限制，**不是安全邊界**：訪客的瀏覽器裡已經有完整的內容。
- 訪客的網址列保持 `/s/<token>`，不換成團譜 id。

## 6. 顯示選項

- 弦樂聲部固定只顯示 TAB 加節奏符桿，不提供「五線譜＋TAB」並列（`projection.ts:216-219`、`alphaTabEngine.ts:94`；並列時一個小節有兩個 `BarBounds`，`spike-report.md:213`）。
- 每個成員自己的顯示選項只有：
  - 顯示哪些聲部（`ScoreRenderer.showParts`）。
  - 縮放。
- 兩者存在 localStorage，以團譜 id 區分（補充：鍵是 `studio.display.<scoreId>`）。
- 寬版的 Read view 預設顯示全部聲部。

## 7. 寬度的界線與手機版面

| 條件 | 視圖 |
|---|---|
| 寬度小於 768 px | 窄螢幕的 Read view |
| 寬度 768–1023 px | 寬版的 Read view，不能打譜 |
| 寬度至少 1024 px，但不是 `(pointer: fine)` | 寬版的 Read view |
| 寬度至少 1024 px，而且 `(pointer: fine)` | 依角色給可編輯視圖或唯讀編輯視圖；訪客一律 Read view |

窄螢幕的 Read view（寬度小於 768 px）：

- 預設一次只顯示一個聲部，用聲部切換器換。各團譜上次選的聲部存在 localStorage（補充：鍵是 `studio.narrowPart.<scoreId>`）；沒有紀錄時用第一個聲部。
- 用 Page 版面，每行小節數交給 alphaTab 依寬度決定。
- 播放列固定在底部，混音面板收在抽屜裡。
- 捲動到頂端時，底部的播放列不能蓋住 alphaTab 的標記（見第 9 節）。

手機與平板（`canType` 為假的裝置）不能打譜（ROADMAP 的「不做的事」）。在這些裝置上可以：

- 看譜與播放（這一節與第 5 節）；
- 在 `/phrases` 上傳圖片辨識，可以直接拍照（[`phrases.md`](phrases.md) 第 4 節）；
- 打開樂句編輯器與審核頁，但只能看、不能改；審核與編輯在桌面做（[`phrases.md`](phrases.md) 第 5、7 節）。

## 8. Presence

awareness 的狀態：

```ts
interface PresenceState {
  accountId: string;     // 伺服器覆寫
  displayName: string;   // 伺服器覆寫
  color: string;         // 伺服器覆寫
  mode: "edit" | "read";
  cursor: Cursor | null;
  selection: Selection | null;
}
```

- `Cursor` 與 `Selection` 的形狀見 [`commands.md`](commands.md)。
- `EditorSession` 只輸出本機的 `{ cursor, selection }`；寫入 `provider.awareness` 由 Vue 殼負責。
- 伺服器在 `beforeHandleAwareness` 用連線的 context 覆寫 `accountId`、`displayName`、`color`，並移除訪客的狀態（ADR 0005、[`collab.md`](collab.md)）。
- **顏色**：把 `accountId` 雜湊到一組 8 色的調色盤，同一個人在每份團譜都是同一個顏色。撞色時靠名牌區分。
  - **補充**：雜湊用 32 位元 FNV-1a，取 `hash mod 8`。
  - **補充**：調色盤依序是 `#d73a49`、`#22863a`、`#005cc5`、`#e36209`、`#6f42c1`、`#0598bc`、`#b31d8f`、`#8a6d3b`。顏色只在伺服器算，寫在 server 的程式裡。
- 同一個帳號開多個分頁：每個分頁的游標都畫出來，成員列表只列一次。
- `mode`：可編輯視圖是 `"edit"`；唯讀編輯視圖與 Read view 是 `"read"`。
- 唯讀編輯視圖的游標用淡色畫。
- Read view 裡的成員：`cursor: null`，只出現在成員列表上。
- 訪客不出現在 Presence，也看不到 Presence。
- 其他人的游標在遠端修改後，用 `settleCursor` 重新解析位置（`navigation.ts:47-59`）。
- 名牌貼在游標旁，遵守 `reservedRects`。
- 停用的帳號在成員列表上，名稱旁顯示「已停用」（[`accounts.md`](accounts.md)）。

## 9. 疊層與 alphaTab 的標記

- `ScoreRenderer.reservedRects(): Rect[]`：疊層不得覆蓋的區域。實作是從 `boundsLookup` 取第一行譜最後一個小節上方的區域，也就是 alphaTab 標記所在的位置；名稱不提 alphaTab（`types.ts:1-2`）。
- 所有疊層都不得畫進這些區域：游標、名牌、選取框、Flag 框、樂句預覽、固定的播放列、提示訊息（補充）。
- 遇到衝突時，疊層移開（例如名牌改貼在游標下方），不是遮住標記。
- e2e 在捲動位置 0 時，斷言所有疊層與 `reservedRects()` 不相交；包含編輯視圖、Read view、窄螢幕、樂句預覽（[`testing.md`](testing.md)）。
- 標記沒有自己的 DOM 元素，它和譜線畫在同一條 path 裡（`spike-report.md:54`），所以只能這樣斷言；目視確認仍是人工項目。
- 規則：整份譜超過 10 小節，或這次畫出的 track 超過 2 個時就顯示；位置是第一行譜最後一個小節的上方；沒有設定可以關掉（`spike-report.md:54,66`）。

## 10. 狀態橫幅

- **離線**：連線中斷時顯示「離線」橫幅；已開啟的分頁可以繼續編輯，重連時由 Yjs 合併（[`collab.md`](collab.md)）。
- **權限改變**：被降級或移除、或 session 失效時，丟掉本機文件並以唯讀重新載入，提示原因。
- **較新的 schema**：以唯讀開啟，提示重新整理（[`schema.md`](schema.md) 第 9 節）。
- **補充**：**缺少遷移步驟**：伺服器回報這份團譜缺少遷移步驟（連線被設成 readOnly，[`schema.md`](schema.md) 第 10 節）時，客戶端也以唯讀開啟並提示原因，免得 Editor 打的字被伺服器丟掉。
- **播放中修改的 (b) 模式**：顯示「播放的是修改前的內容」（[`playback.md`](playback.md)）。
- **補充**：同步狀態以畫面上的指示器呈現（例如「已同步」「同步中」「離線」），並帶 `data-sync` 屬性給 e2e 讀。
