# 共編伺服器、持久化、版本

`/collab` 的 Hocuspocus 設定、驗證、在場、斷線，以及版本的建立、保存與還原。設計理由見 ADR 0001、ADR 0002 增補、ADR 0005。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 文件與持久化

- 一份團譜對應一個 Hocuspocus document，`documentName` 就是團譜 id。
- Yjs 狀態以 `bytea` 存在 Postgres，是唯一的真相。
- 每次儲存都整份覆寫 `Y.encodeStateAsUpdate`，不存增量（100 × 5 的譜約 501–558 KB，S4）。
- 這取代 spike 存在記憶體裡的 `Map`（`apps/server/src/collab.ts:17-25`）。
- 繼續用 crossws 把 Hocuspocus 掛在 Fastify 的 `/collab`（`collab.ts`）。Hocuspocus v4 沒有「掛到既有 HTTP server」的現成方法，升版時要對照它的 `Server.ts`。
- **補充**：儲存的 debounce 用 Hocuspocus 的 `debounce: 2000`、`maxDebounce: 10000`（毫秒）。最後一個連線離開時立即儲存（Hocuspocus 的預設行為）。

### 1.1 `scores` 表（補充：欄位草案）

| 欄位 | 說明 |
|---|---|
| `id` | 團譜 id（`documentName`） |
| `title`、`artist` | 從文件的 `meta` 鏡射，供列表使用 |
| `doc_state` | `bytea`，`Y.encodeStateAsUpdate` 的結果 |
| `schema_version` | 文件目前的 `schemaVersion` |
| `link_token` | 唯讀連結的 token，可以是 null（[`accounts.md`](accounts.md)） |
| `created_at`、`updated_at`、`deleted_at` | `updated_at` 在每次儲存時更新，「我的團譜」依它排序 |

## 2. Hocuspocus 掛鉤

| 掛鉤 | 做什麼 |
|---|---|
| `onAuthenticate` | 用 collab ticket 查出帳號或唯讀連結，以及角色（第 3 節）。不存在、已刪除、或和 ticket 不符的團譜 id 一律拒絕，避免建出空文件（`spike-report.md:348`）。Viewer 與訪客設 `readOnly` |
| `onLoadDocument` | 從 `scores.doc_state` 載入；跑 `Y.Doc` 那一面的遷移（[`schema.md`](schema.md) 第 10 節）。遷移只放在這裡。**補充**（#12）：遷移之後也執行一次 `fillMissingContent`（第 4 節）。文件比伺服器新、或缺少遷移步驟時，凍結這份文件（2.1） |
| `onChange` | debounce 過之後，以參與者身分執行 `fillMissingContent`（第 4 節） |
| `beforeHandleMessage` | **補充**（#12）：文件被凍結時，把這條連線設成 `readOnly`（2.1） |
| `connected` | 連線進對照表（第 6 節）。**補充**（#12）：文件被凍結時，送出 `readOnly` 通知（2.1） |
| `onStoreDocument` | 整份覆寫 `doc_state`；把 `title`、`artist` 鏡射到 `scores` 表；更新 `schema_version`、`updated_at`。**不要**在這裡修改文件，否則會再觸發一次儲存。**補充**（#12）：`title`、`artist`、`schemaVersion` 用 `readScore` 讀，讀不懂的 `title` 鏡射成空字串、`artist` 鏡射成 null、`schemaVersion` 鏡射成目前的版本，不丟例外；被凍結的文件完全不寫（`updated_at` 也不動） |
| `beforeHandleAwareness` | 覆寫身分欄位、移除訪客的狀態（第 5 節） |
| `onDisconnect` | 剩 0 個連線時建立版本（第 8 節） |
| `afterLoadDocument`、`afterUnloadDocument` | 開始、停止這份文件的 10 分鐘版本計時器（補充） |

- 新團譜的初始內容（聲部、小節、拍號、速度）由伺服器以參與者身分建立，客戶端不建：`POST /api/scores` 在伺服器端建好 `Y.Doc`、寫進 `scores.doc_state`，然後回傳 id。
- 讀取用的函式（建立版本、鏡射標題）和客戶端是同一個 `docToJson`，讀取時容錯（[`schema.md`](schema.md) 第 11 節）。
- **補充**（#12）：Hocuspocus 在 `onLoadDocument` 結束之後才開始監聽文件的變動，而且沒人修改過的文件在最後一條連線離開時直接卸載、不儲存。所以載入時的遷移或補齊**確實改了文件**時，`onLoadDocument` 自己立刻存一次（`doc_state`、`title`、`artist`、`schema_version`、`updated_at`，和 `onStoreDocument` 同一個函式）；沒有改動時不存。理由：不存的話，下次載入會用新的 Yjs client id 重做一次，還留著上一次那些操作的分頁（斷線重連、離線編輯）把它們推回來時，同一個小節的兩個內容容器只留一個，寫在另一個裡的音符會無聲消失。這次儲存失敗時只寫 error log，文件照常開啟，隨下一次修改儲存。載入時的補齊丟例外時也只寫 error log、照常開啟。

### 2.1 凍結的文件與 `readOnly` 通知（補充，#12）

伺服器載入時發現文件比自己新（[`schema.md`](schema.md) 第 9 節）、缺少遷移步驟（第 10 節）、或某個遷移步驟執行時丟出例外，這份文件在記憶體裡的期間就是**凍結**的：

- 不遷移、不執行 `fillMissingContent`、不儲存（關閉伺服器時的儲存也跳過）。遷移在一份複本上執行，所以步驟執行到一半失敗時，成員拿到的仍是資料庫裡原本的內容。
- 每一條連線都是 readOnly，Owner 與 Editor 也一樣。第一批連線在文件載入之前就通過了 `onAuthenticate`，那時還不知道要凍結，所以不在那裡設，而是在 `beforeHandleMessage` 設 `connection.readOnly`：每則訊息（包含載入期間排隊的）套用之前都會經過它。Hocuspocus 在驗證通過時回給 provider 的 `scope` 因此可能仍是 `read-write`，客戶端不能靠它判斷。
- 伺服器自己的修改（`app.collab.change`）也被拒絕（丟例外）。
- 文件卸載後解除；下次載入重新判定（部署補上遷移之後就恢復正常）。

**回報管道**：伺服器在 `connected` 掛鉤對這條連線送一則 Hocuspocus stateless 訊息（`connection.sendStateless`），內容是 JSON，形狀是 `packages/contracts` 的 `collabNotice`：

```ts
{ type: "readOnly", reason: "newerSchema" | "missingMigration" | "migrationFailed" }
```

- 每條連線建立時（包含重連）送一次；文件沒有被凍結時不送。訪客與 Viewer 也收得到（他們本來就唯讀，可以忽略）。
- 這則訊息在連線建立時就送出，通常早於同步完成：客戶端要在建立 provider 時就給 `onStateless`，不能等 `synced` 之後才掛。
- 客戶端收到後以唯讀開啟並提示原因（[`views.md`](views.md)）。`newerSchema` 客戶端自己也讀得出來（`meta.schemaVersion`）；`missingMigration`（缺步驟，`migrateDoc` 丟 `MissingMigration`）與 `migrationFailed`（步驟執行失敗；log 裡兩者的訊息不同）只有這則通知能告訴它。
- `type` 留給日後其他通知使用；客戶端忽略不認得的 `type`。

## 3. Collab ticket

成員和訪客都用同一種短期 ticket（ADR 0005）。

| 誰 | 怎麼取 | 回應 |
|---|---|---|
| 成員 | 帶 session cookie 呼叫 `POST /api/scores/:id/collab-ticket` | `{ ticket, role }` |
| 訪客 | 呼叫 `POST /api/s/:token` | `{ scoreId, title, ticket }`（補充：附上標題供頁面顯示） |

- ticket 有效 60 秒，只能用一次，內容帶「帳號（與 session id）或連結 token」、團譜 id 與角色。
- **補充**：ticket 是 32 bytes 的亂數（base64url），存在 Redis：鍵 `collab-ticket:<ticket>`、TTL 60 秒，用 `GETDEL` 取出保證只用一次。
- **補充**：`onAuthenticate` 除了檢查 ticket 的團譜 id 等於 `documentName`，也重新讀一次資料庫裡目前的角色（或連結 token 是否仍有效），以免 ticket 發出後 60 秒內的權限變動被略過。
- provider 的 `token` **一律傳函式**，每次連線（包含重連）都重新取一張新的 ticket（`@hocuspocus/provider` 的 `.d.ts:327`，型別是 `string | (() => string) | (() => Promise<string>) | null`）。傳固定字串的話，重連時會失敗。
- WebSocket upgrade 時不使用 cookie，所以不必處理跨站 WebSocket 劫持（CSWSH）。
- ticket 發放的速率限制見 [`security.md`](security.md)。

## 4. 補齊內容容器

- 只有伺服器補齊缺少的內容容器：在 debounce 過的 `onChange` 裡，以參與者身分執行 `fillMissingContent`（`commands.ts`）。客戶端不補（ADR 0002:21）。
- `fillMissingContent` 也補齊缺少的聲線（[`schema.md`](schema.md) 1.1）。
- **補充**：debounce 1000 ms。沒有缺漏時不開交易，避免觸發多餘的儲存。
- **補充**（#12）：補齊直接在伺服器記憶體裡的文件上執行，像任何修改一樣廣播給成員並排進 debounce 的儲存。所有連線在 debounce 到期之前就離開、文件已卸載時，這次補齊不做；下次載入時在 `onLoadDocument` 補上並立刻儲存（第 2 節）。凍結的文件不補（2.1）。

## 5. 在場（awareness）

- Viewer 與訪客的連線是 `readOnly`：Hocuspocus 會丟棄它們送來的 Update 與 SyncStep2（`hocuspocus-server.esm.js:268-290`）。但 Awareness 不受 readOnly 影響，所以要靠下面的掛鉤擋。
- `beforeHandleAwareness`：用連線的 context 覆寫每個狀態的 `accountId`、`displayName`、`color`，並移除訪客連線的狀態。依據：修改後的狀態會被重新編碼再套用（`hocuspocus-server.esm.js:196-215`）。
- **訪客看不到在場**：Hocuspocus 把 awareness 廣播給同一份文件的每一條連線，沒有過濾的掛鉤（`Document.broadcastAwarenessUpdate`，:675-677），連線建立時還會送一次目前的狀態（`sendCurrentAwareness`，:434-438）。**補充**：所以在 `collab.ts` 的 crossws 介接層，包住訪客連線的 socket：送出的訊息若是 Awareness 類型（訊息開頭的文件名稱之後，`varUint` 類型是 1），直接丟掉。訪客的客戶端也不設定本機的 awareness 狀態（provider 的 `awareness: null`）。
- **補充**（#14）：訪客因此收不到任何 awareness；文件沒有人修改時，訪客的 socket 會完全沒有訊息進來，而 provider 30 秒沒收到訊息就重連（`messageReconnectTimeout`），每次都要取一張新 ticket。所以訪客的 provider 設 `forceSyncInterval: 15000`，每 15 秒送一次 SyncStep1，伺服器的回覆讓連線保持活著。
- 顏色的雜湊與調色盤見 [`views.md`](views.md) 第 8 節。
- `displayName` 改了之後，下一次該成員送出 awareness 時就會帶上新名稱（補充：伺服器在每條連線的 context 裡保存顯示名稱，改名時一併更新）。

## 6. 伺服器主動斷線

- 伺服器記住每條連線對應的帳號、session id、或連結 token，以及團譜 id（補充：一份在記憶體裡的對照表，連線建立時加入、關閉時移除）。
- 以下情況，伺服器主動關閉相關的連線：成員被移除或降級、擁有權轉移、成員離開、登出、改密碼、重設密碼、帳號停用、唯讀連結被撤銷或重新產生、團譜被刪除。各自關哪些連線見 [`accounts.md`](accounts.md) 第 9 節。
- 只關相關的連線時，不能用 `closeConnections(documentName)`，因為它會關掉整份文件的所有連線（`index.d.ts:207`）。用個別連線的 `close()`（`index.d.ts:1005`）。
- **補充**：關閉時用 `@hocuspocus/common` 的 `Forbidden`（權限變動、連結撤銷、團譜刪除）或 `Unauthorized`（session 結束）。
- **補充**（#6）：關閉一條連線時，先用 `Connection.close()` 讓它離開文件（之後它送來的東西不再套用），再關閉它的 WebSocket。只送 Hocuspocus 的 CLOSE 訊息的話，provider 不會重連，那份文件就停在那裡；關掉 socket，provider 才會重連，並取一張新的 ticket。函式是 `app.collab.closeConnections({ scoreId?, accountId?, sessionId?, linkToken? }, event)`，只關所有欄位都相符的連線。
- **補充**（#6）：`onAuthenticate` 也確認 ticket 的 session 還沒結束，以免 ticket 發出後到連上之間結束的 session 留下連線。
- **補充**（#6、#14）：連線要到 `connected` 掛鉤才進對照表，而文件在那之前就從 Postgres 載入。這段時間發生的事件用「載入中」的標記處理，不需要 I/O：`onAuthenticate` 一取出 ticket、在查資料庫之前，就把這條連線（帳號、session、連結 token、團譜 id）放進載入中的集合，查核失敗時移除；`closeConnections` 除了關閉對照表裡符合的連線，也在載入中符合的連線上記下關閉的事件，並立刻關閉它的 socket，讓它收不到文件；萬一 Hocuspocus 還是走到 `connected`，看到記號就以那個事件關閉。所以 session 結束、成員被移除或降級、連結撤銷、團譜刪除，不論發生在查核之後或載入期間，都關得到這條連線（#6 原本在 `connected` 再查一次 session 的做法因此拿掉）。載入失敗、沒有走到 `connected` 的連線，在它的 socket 關閉時移出集合。

## 7. 客戶端：斷線、離線、重連

- 已開啟的分頁可以繼續編輯，重連時由 Yjs 合併；畫面顯示「離線」橫幅。
- 不做 IndexedDB 離線保存。
- `provider.unsyncedChanges > 0` 時，用 `beforeunload` 警告（`provider.unsyncedChanges` 在 `ScoreView.vue` 的 `updateSync` 裡讀得到）。
- 重連時：
  - 取 ticket 失敗（401 或 404），或拿到的 `role` 比原本低：客戶端丟掉本機的 `Y.Doc`，重新以唯讀載入並提示；本機未同步的修改放棄。只切換介面不夠，因為本機文件已經和伺服器分歧了。
  - **補充**：401 時提示「登入已失效」並導向 `/login`；404 時提示「你已經不是這份團譜的成員，或團譜已被刪除」並導向 `/`；角色降低時提示「你的角色已改為檢視者」，以唯讀編輯視圖或 Read view 重新載入。
  - 角色變高（例如 Viewer 被改成 Editor）：**補充**：重新載入頁面，以新的角色開啟。
- 訪客的連結被撤銷或重新產生：伺服器關閉連線，重連時取 ticket 回 404。**補充**（#14）：頁面停止重連，狀態顯示「已斷線」，並提示「這個唯讀連結已經失效。」；已經畫出的譜留在畫面上（內容本來就在訪客的瀏覽器裡）。重新整理之後，取 ticket 回 404，顯示 404 頁。

## 8. 版本

### 8.1 用詞與內容

- 只用一個詞 **Version（版本）**：某一刻的 `docToJson` 結果，存成一列。snapshot、history、revision 都列為 Avoid；前身專案的 Revision（版次）是別的意思。
- 儲存格式：gzip 過的 `bytea`，另有 `schema_version` 欄位。不用 jsonb，因為不需要在資料庫裡查詢內容。100 × 5 的譜約 300 KB，200 個版本約 60 MB／份（未壓縮的估計）。

### 8.2 `versions` 表（補充：欄位草案）

| 欄位 | 說明 |
|---|---|
| `id`、`score_id`、`created_at` | |
| `schema_version` | 建立時的 `schemaVersion` |
| `content` | gzip 過的 `ScoreJSON`（`bytea`） |
| `content_hash` | 補充：鍵依字母排序後的 `ScoreJSON` 的 SHA-256，用來判斷「和最新版本相同」 |
| `byte_size` | 壓縮前的大小 |
| `reason` | 補充：`'last_disconnect'`、`'interval'`、`'before_restore'` |
| `name` | 手動命名（M5）；null 表示自動版本 |
| `created_by` | 補充：`before_restore` 是發起還原的帳號；自動版本是 null |

**補充**（#17）：`created_at` 是寫入那一刻資料庫的時鐘（`clock_timestamp()`），不是交易開始的時間；同一份團譜的版本在鎖住該團譜列的交易裡一次建一個，所以 `created_at` 的順序就是建立的順序。`content` 存的是鍵排序後的 JSON，`content_hash` 就是這段文字的 SHA-256（hex）。`reason` 有 check constraint；`created_by` 的外鍵是 `ON DELETE SET NULL`。

### 8.3 什麼時候建立

兩者都只在內容和該團譜最新的版本不同時才建（比較 `content_hash`）：

1. **最後一個連線離開時**：Hocuspocus 的 `onDisconnect`，剩 0 個連線時，用記憶體裡的文件建立。**補充**：只用 `onDisconnect`，不在 `afterUnloadDocument` 再建一次（內容比較也會擋掉重複，但文件卸載後就不在記憶體裡了）。
2. **連續編輯中，每 10 分鐘一次**：文件載入期間的計時器。
3. **還原前**（`reason = 'before_restore'`）：見 8.5。**補充**：內容和最新版本相同時不另建，直接回傳最新版本的 id。

**補充**（#17）：

- 團譜還沒有任何版本時，「和最新的版本不同」一定成立：第一次有成員離開（或第一個 10 分鐘）就會建立第一個版本，即使沒有人改過內容。
- 伺服器自己的連線（`collab.change`，例如 `POST /api/scores` 建立初始內容）結束時不建立版本；版本在成員離開時才建。
- 凍結的文件（2.1）不建立版本：這台伺服器不保證讀得懂它。
- `onDisconnect` 會等版本建完才讓文件卸載。建立失敗只寫 error log，不影響儲存與卸載；下一次建立時用當時的內容。
- 伺服器關閉時（`preClose`），替每一份還在記憶體裡的文件建立一次版本（`reason = 'last_disconnect'`），並等進行中的版本建完，再關資料庫。
- 已軟刪除的團譜照樣建立版本（刪除時成員的連線被關閉，就是「最後一個連線離開」），還原後版本都在；團譜列已經永久刪除時不建。
- 版本的大小上限是 8 MB（未壓縮的 JSON 位元組數，`MAX_VERSION_BYTES`），和 WebSocket 單則訊息的上限相同（[`security.md`](security.md) 第 5 節）：還原是把整份內容當一筆交易送出，更大的版本本來就還原不了。超過時不建立版本、寫 error log，儲存與關閉照常。M5 讀取版本時，解壓要以同一個上限設 `maxOutputLength`。
- 10 分鐘的計時器從 `afterLoadDocument` 跑到 `afterUnloadDocument`，不看有沒有人在編輯；內容沒變的那一次不會建立版本。
- **補充**（#114）：內容在鎖住團譜列之後才讀（`createVersion` 收的是讀內容的函式），所以同一份團譜的版本依「讀內容」的順序提交，最新一筆一定是最後讀到的內容。計時器那一次若等到鎖時內容已經變了，建立的是當時的內容（`reason` 仍是 `interval`）；和最新版本相同就不建。

M1a 只做自動建立，沒有介面；M5 做列表、預覽、命名、還原。

### 8.4 保留

- 每份團譜最多 200 個自動版本（`name` 是 null 的，包含 `before_restore`）；超過時刪最舊的自動版本。
- 手動命名的版本（M5）不會被自動刪除。**補充**：命名就是替一個既有的版本加上名稱，1–100 字元；把名稱清掉，它就回到自動版本的保留規則。
- 團譜永久刪除時，版本一起刪除（[`accounts.md`](accounts.md) 第 8 節）。

### 8.5 還原

還原是「就地還原」，Owner 與 Editor 可以做：

1. **補充**：在 `/scores/:id/versions` 選一個版本按「還原」，先跳確認對話框：「這會以這個版本取代目前的內容；目前的內容會先存成一個版本」。
2. 客戶端 `POST /api/scores/:id/versions`，由伺服器存下**伺服器當下**的內容（`reason = 'before_restore'`）。前一步失敗就不還原，顯示錯誤。
3. 客戶端 `GET /api/scores/:id/versions/:versionId` 取得版本的 JSON；版本的 `schemaVersion` 比較舊時，伺服器先跑 JSON 遷移，回傳目前版本的 JSON。
4. 成功之後，客戶端送出 Command `replaceScore(versionJson)`：在一筆交易裡以版本的內容取代現有內容（`meta` 的 `title`、`artist`，所有小節與聲部），保留版本裡的 id，是一個復原步驟。
5. 這筆交易經由 WebSocket 送出；100 × 5 約 501 KB，所以單則訊息的上限是 8 MB（[`security.md`](security.md)）。

- 同時正在被別人修改的內容會消失；事前存下的版本就是保險。
- `jsonToDoc` 放在 `score-model`，和匯入共用。
- **補充**：`/scores/:id/versions` 是團譜頁裡的一個路由，和 `/scores/:id` 共用同一個 `Y.Doc` 與 provider；`replaceScore` 在這份文件上執行，完成後回到 `/scores/:id`。同一個分頁可以用復原鍵（`Ctrl+Z`，Mac 是 `Cmd+Z`）復原這次還原。
- 不做「還原成新團譜」，不做逐小節的差異比對或合併。

### 8.6 預覽（M5）

- 版本列表顯示建立時間、原因、名稱、大小。
- 預覽用 Read view 的 renderer 畫遷移後的 JSON，不連線、不改文件（補充）。

## 9. 信任模型

- Editor 視為可信任。伺服器只靠 readOnly 與訊息大小上限把關，不檢查更新的內容；容錯在讀取時做（[`schema.md`](schema.md) 第 11 節）。
