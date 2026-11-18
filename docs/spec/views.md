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
- alphaTab 的捲動已經關掉（`alphaTabEngine.ts` 的 `ScrollMode.Off`），跟隨由殼自己做，所以 `ScoreRenderer` 有「由播放位置（tick）查座標」的方法 `boundsAtTick`（#31，細節見 [`playback.md`](playback.md) 4.1）。
- **補充**（#31）：`EngineOptions.seekOnClick` 預設關閉；Read view 要點譜面跳過去時再打開。
  - **補充**（#32）：alphaTab 1.9 只有在它自己的播放游標打開時（`enableCursor`）才會點譜面跳過去，而我們把它關掉了；所以 `seekOnClick` 由引擎自己做：聽 `beatMouseUp`，用 tick lookup 算出那個拍點第一次播到的 tick，走和 `seek` 一樣的路（聲音產生期間點的，聲音換好之後跳到那裡）。
  - **補充**（#33）：有循環時，點擊位置夾在循環範圍內（`seek` 本身就夾，見 [`playback.md`](playback.md) 第 4 節）。目前沒有任何視圖同時有 `seekOnClick` 與循環（Read view 沒有選取，編輯視圖點譜面不跳），所以只在 `engine.test.ts` 測，沒有 e2e。
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

- 點譜面就跳到那裡播放。**補充**：點擊只移動播放位置；正在播放就從那裡接著播，暫停中則停在新位置，等按播放才開始（避免一點譜面就突然出聲；iOS 也要在使用者的手勢裡啟動音訊）。在這個視圖裡 `enableSeekToClick` 是 `true`（補充：真正跳過去的是引擎，見第 2 節 #32 的補充）。
- 沒有 Selection、沒有 Cursor。**補充**（#68）：Owner、Editor 的 Read view 有一個沒有游標的 `EditorSession`（`cursorless`），只為了還原版本（[`collab.md`](collab.md) 8.5）：只有復原與重做鍵有作用，不產生游標。
- 播放時一直自動跟隨。**補充**（#32）：手動捲動不會停止跟隨；正在播的 system 沒有整個在畫面上時，照 [`playback.md`](playback.md) 4.1 的規則捲回去。
- **補充**（#32）：播放的起點是目前的播放位置；工具列一直顯示播放位置所在的小節（一開始是第 1 小節），疊層畫出播放位置。停止回到開頭，仍然顯示第 1 小節。`Space` 一樣是播放／暫停。
- **補充**（#32）：其他成員的修改照 [`playback.md`](playback.md) 第 3 節的 (a) 重新產生聲音，和編輯視圖相同。
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
  - **補充**（#32）：值是 `{ hidden: string[]; scale: number }`。存的是**隱藏**的聲部，所以之後新增的聲部預設顯示；全部被隱藏時（例如隱藏的聲部之外的都被刪掉）顯示全部。縮放只有 50%、75%、100%、125%、150%、200%，讀不懂的值當成 100%。最後一個顯示中的聲部不能隱藏。實作在 `apps/web/src/display.ts`，介面是工具列的「顯示聲部」選單與「縮放」。
  - **補充**（#32）：在編輯視圖隱藏了游標所在的聲部時，游標移到第一個顯示中的聲部的同一個小節。
  - **補充**（#32）：排版進行中改了顯示的聲部或縮放，等這次排版完成後整份重新排版（`ScoreRenderer.showParts`、`setScale`）。
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
  - **補充**（#32）：播放列是頁面版面的最後一列，譜面捲動區在它上面結束，所以播放列從不疊在譜面上；抽屜打開時在播放列上方，把譜面往上推，也不疊在譜面上。抽屜裡是縮放與混音（#33）；抽屜最高 45vh，放不下就在抽屜裡捲動。聲部切換器在上方的工具列。
  - **補充**（#32）：窄螢幕與否和視圖一樣，只在載入頁面時判定一次。
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
- 其他人的游標在遠端修改後，用 `settleCursor` 重新解析位置（`navigation.ts` 的 `settleCursor`）。
- 名牌貼在游標旁，遵守 `reservedRects`。
- 停用的帳號在成員列表上，名稱旁顯示「已停用」（[`accounts.md`](accounts.md)）。
- **補充**（#34）：客戶端的寫法在 `apps/web/src/presence.ts`。
  - 寫入：`joinPresence` 包住 provider 的 awareness，殼在每次 `onPresence`、視圖改變時以 `localStateOf(view, presence)` 整份寫入本機狀態（Read view 一律 `cursor: null`、`selection: null`）。`ScoreView` 被關掉（#35 換新的 `ScoreView`）或卸載時先 `leave()`（本機狀態設為 null），新的 `ScoreView` 是新的 `Y.Doc`、新的 client，不留幽靈游標；伺服器在連線關閉時也會移除那條連線的狀態。
  - 斷線重連：y-protocols 不套用 clock 沒有變新的狀態，而伺服器移除狀態、provider 丟掉別人的狀態時都不改 clock，重連後雙方要等各自每 15 秒的更新才看得到彼此。所以 provider 關閉時（`onClose`）刪掉別人的 clock（`disconnected`），重新同步時（`onSynced`）再寫一次本機狀態讓 clock 加一（`reconnected`），重連後雙方立刻看得到彼此。
  - 只有自己的狀態變動時（每次移動游標）不重讀別人的狀態；別人的狀態只重新解析變動的那幾個。
  - 讀取：其他分頁的狀態用 `packages/contracts` 的 `presenceState` 解析，形狀不對的略過；成員列表（`membersOf`）每個帳號一列，不列自己的帳號（自己的其他分頁仍畫出游標），任一分頁是 `edit` 就算 `edit`，`read` 的成員標「（檢視中）」。成員也看得到其他人的游標，三種視圖都畫；訪客的 provider 沒有 awareness，什麼都不畫。
  - 其他人的游標每次排版後與 awareness 改變時重新放置（`peerMarksOf`）：`settleCursor` 不帶位置，聲部、小節或聲線不在時不畫（含 0 小節、0 聲部），`line` 夾在聲部的範圍內。選取照畫，指到的拍點或小節不在時不畫。編輯中的游標用成員的顏色，`read` 的淡色；選取框更淡。
  - 名牌是 HTML 文字（只當文字渲染），大小由 `tagWidth` 估算並以這個大小畫出（名字太長就截斷），放在游標上方、左緣對齊；上方會碰到保留區域或超出頁面頂端時改放游標下方，仍碰到就移到保留區域下方（`tagRect`）。
  - 小節範圍的選取框（自己的與其他人的）只在保留區域底下的那一段切掉（`overlay.ts` 的 `clearPieces`），同一行的其他小節保持原高度（#21 審查）；拍點範圍仍照 `clearOf`。

## 9. 疊層與 alphaTab 的標記

- `ScoreRenderer.reservedRects(): Rect[]`：疊層不得覆蓋的區域。實作是從 `boundsLookup` 取第一行譜最後一個小節上方的區域，也就是 alphaTab 標記所在的位置；名稱不提 alphaTab（`types.ts:1-2`）。
- 所有疊層都不得畫進這些區域：游標、名牌、選取框、Flag 框、樂句預覽、固定的播放列、提示訊息（補充）、拍點文字的內嵌輸入框（補充，#30：開在游標下方，以 `overlay.ts` 的 `entryRect` 移到保留區域下方）。
- 遇到衝突時，疊層移開（例如名牌改貼在游標下方），不是遮住標記。
  - **補充**（#19）：標記沒有自己的範圍可查，所以保留區域取保守的範圍：在第一行譜最後一個小節的右端，和標記一樣寬（`geometry.ts` 的 `MARK_WIDTH`），從第一行譜的上緣到最上面那個譜表的第一條線。伸進這個區域的疊層，伸進去的部分切掉；整個在裡面的移到它下方（`apps/web/src/overlay.ts` 的 `clearOf`）。例如游標停在那個小節第一條弦的附加位置時，上緣會伸進去一點，那一截被切掉。
  - **補充**（#19）：疊層層裡每個保留區域放一個看不見、不接收滑鼠的 `<rect data-reserved>`，e2e 從 DOM 讀它，不必擴充 `__studioTest`。
- e2e 在捲動位置 0 時，斷言所有疊層與 `reservedRects()` 不相交；包含編輯視圖、Read view、窄螢幕、樂句預覽（[`testing.md`](testing.md)）。
- 標記沒有自己的 DOM 元素，它和譜線畫在同一條 path 裡（`spike-report.md:54`），所以只能這樣斷言；目視確認仍是人工項目。
- 規則：整份譜超過 10 小節，或這次畫出的 track 超過 2 個時就顯示；位置是第一行譜最後一個小節的上方；沒有設定可以關掉（`spike-report.md:54,66`）。

## 10. 狀態橫幅

- **離線**：連線中斷時顯示「離線」橫幅；已開啟的分頁可以繼續編輯，重連時由 Yjs 合併（[`collab.md`](collab.md)）。
- **權限改變**：被降級或移除、或 session 失效時，丟掉本機文件並以唯讀重新載入，提示原因。
- **較新的 schema**：以唯讀開啟，提示重新整理（[`schema.md`](schema.md) 第 9 節）。
  - **補充**（#35）：判斷是 `apps/web/src/access.ts` 的 `readOnlyReasonOf`（文件的 `meta.schemaVersion` 比 `SCHEMA_VERSION` 新）與 `openedView`（可編輯視圖變成唯讀編輯視圖，另外兩種不變）。每次畫譜時都檢查：同步後第一次畫就發現的，以唯讀編輯視圖開始；已經在可編輯視圖打譜時才變新的（新版伺服器遷移過），丟掉本機文件、以唯讀重新開啟。伺服器的 `readOnly` 通知（#109）走同一個入口（`ScoreView.vue` 的 `lockReadOnly`，理由是通知的 `reason`）。
  - **補充**（#35）：被鎖成唯讀的 Owner 或 Editor 按了會修改的鍵時，提示的是鎖住的理由，不是「檢視者無法修改」。
- **補充**：**缺少遷移步驟**：伺服器回報這份團譜缺少遷移步驟（連線被設成 readOnly，[`schema.md`](schema.md) 第 10 節；回報是 `reason: "missingMigration"` 或 `"migrationFailed"` 的 `readOnly` 通知，[`collab.md`](collab.md) 2.1）時，客戶端也以唯讀開啟並提示原因，免得 Editor 打的字被伺服器丟掉。
  - **補充**（#109）：只鎖 Owner 與 Editor（Viewer、訪客本來就唯讀，不提示）。已在可編輯視圖才收到通知時，以唯讀重新開啟，而且重新開啟的團譜一開始就是唯讀。鎖住之後分頁內不自動解除，到頁面重新載入為止；`strings.score.readOnly` 的三則文字都說明要重新整理頁面。Read 視圖（無法打字的裝置）被鎖時不建立還原用的無游標 session；已經建立的，鎖住時收掉（`destroy`），復原、重做不再寫進本機文件。丟掉本機修改時重新開啟的說明寫明這件事。已鎖的 Editor 被降成 Viewer 時，按會修改的鍵提示「檢視者無法修改」，不沿用鎖的理由（`access.ts` 的 `whyRefused`）。版本頁在已鎖時按「還原」，顯示鎖住的理由（`restore.ts` 的 `{ locked }`），不顯示「團譜還在載入」。細節在 [`collab.md`](collab.md) 2.1。e2e 在 `apps/web/e2e/readOnly.spec.ts`（`seedScore` 的 `schemaVersion: 0`：沒有任何遷移步驟從 schema 0 出發）。
- **補充**（#102）：**伺服器不再接受這個分頁**：伺服器送來 `closed` 通知（`reason: "tooDeep"`，[`collab.md`](collab.md) 2.1、第 9 節）時，分頁停止重連，同步指示器停在「離線」，在譜面上方顯示 `strings.score.closed` 的說明（`data-closed`，取代離線橫幅：恢復連線也不會合併），說明之後的修改不會儲存，並給「重新載入」按鈕：以伺服器上的內容重新開啟團譜，這個分頁沒儲存的修改全部丟掉。
- **播放中修改的 (b) 模式**：顯示「播放的是修改前的內容」（[`playback.md`](playback.md)）。
  - **補充**（#33）：和離線橫幅一樣在譜面上方（`data-behind`），聲音換好就消失。
- **補充**：同步狀態以畫面上的指示器呈現（例如「已同步」「同步中」「離線」），並帶 `data-sync` 屬性給 e2e 讀。
  - **補充**（#19）：`synced` 表示已和伺服器同步，而且本機的修改都已經由伺服器確認收到（`provider.isSynced && provider.unsyncedChanges === 0`；`unsyncedChanges` 在伺服器回覆 SyncStatus 時才減少）；還有修改沒被確認時是 `syncing`；連線中斷時是 `offline`，離線時繼續輸入不會讓它變回 `syncing`。
