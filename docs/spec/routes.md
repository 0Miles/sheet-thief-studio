# 路由與 API

標「補充」的是 spec 撰寫者保守補上的細節。API 路徑與欄位名稱是大綱：做那張票的人可以調整細節，但要同時改這份文件。

## 1. SPA 的路由（vue-router）

| 路由 | 頁面 | 里程碑 |
|---|---|---|
| `/login` | 登入；M5 加上 karyl-chan 登入的說明 | M1a |
| `/account/password` | 強制改密碼的關卡（router guard） | M1a |
| `/` | 我的團譜 | M1a |
| `/scores/:id` | 依三種視圖的判定函式，給出對應的視圖（[`views.md`](views.md)）；非成員回 404 | M1a |
| `/scores/:id/settings` | 成員、唯讀連結、擁有權轉移、刪除 | M1a |
| `/scores/:id/versions` | 版本列表（預覽、命名、還原） | M5 |
| `/s/:token` | 訪客的 Read view，網址列不換成團譜 id | M1a |
| `/phrases` | 樂句庫，含「從圖片辨識」；手機與平板也可以上傳（[`phrases.md`](phrases.md) 第 4 節） | M4 |
| `/phrases/:id` | 樂句編輯器；在不能打譜的裝置上只能看 | M4 |
| `/recognitions/:id` | 審核頁；在不能打譜的裝置上只能看 | M4 |
| `/account` | 顯示名稱、改密碼、登出所有裝置 | M1a |
| `/admin` | 後台，只有 admin 能進 | M1a |
| 找不到頁面 | 404 頁 | M1a |

- 除了 `/login` 與 `/s/:token`，所有頁面都要登入；沒有 session 時導向 `/login`，登入後回到原本的頁面（補充）。M0 的技術驗證頁暫時例外，#37 移除它們：`/local` 不需要登入；`/spike/<團譜 id>` 的頁面本身不擋，但共編要先登入、是那份團譜的成員，並和其他頁面一樣每次連線取一張 collab ticket（#6）。
- `must_change_password` 為真時，除了 `/account/password` 與登出，所有頁面都導向 `/account/password`。
- `/admin`：非 admin 看到 404 頁（補充）。
- `/scores/:id/settings`（補充）：Owner 看到所有管理功能；Editor 與 Viewer 只看到成員名單與「離開團譜」。
- `/scores/:id/versions` 和 `/scores/:id` 共用同一個 `Y.Doc` 與 provider（[`collab.md`](collab.md) 8.5）。

`/` 的內容：

- 列出自己是成員的團譜，依更新時間排序，顯示標題、artist、角色。
- 有「建立」按鈕；M5 加上「匯入」。
- Owner 另外看得到「已刪除」區塊（30 天內可以還原）。

## 2. 伺服器的路由（Fastify）

| 路由 | 說明 | 里程碑 |
|---|---|---|
| `/api/*` | JSON API（第 3 節） | M1a |
| `/collab` | WebSocket，Hocuspocus（[`collab.md`](collab.md)） | M1a |
| `GET /auth/karyl` | karyl-chan 登入的回呼。**是 Fastify 的伺服器路由，不在 vue-router 裡**（[`karyl-login.md`](karyl-login.md)） | M5 |
| `GET /healthz` | 健康檢查（已經存在） | M0 |
| 其他 `GET` | 正式環境由 server 回傳打包好的 SPA：`/assets/*` 是靜態檔，其他路徑回 `index.html`（補充；開發時由 Vite 處理） | M1a |

## 3. API 大綱

通則（補充）：

- 請求與回應都是 JSON（辨識的圖片上傳除外）。
- 錯誤回應的形狀是 `{ code: string, params?: object }`。`code` 是穩定的英文代碼，介面依 `code` 顯示 `apps/web/src/strings.ts` 裡的繁中文字；伺服器不回傳給人看的句子。
- 成功但沒有內容時回 204。
- 所有非 GET 請求都檢查 `Origin`（[`security.md`](security.md)）。
- **補充**：`/api/*` 的 route 預設都要 session，沒有就回 401 `unauthenticated`；不需要登入的 route（登入、登出、訪客取 ticket）要在 route 設定上明確標成 public，忘了標就是要登入（#5）。
- 資料形狀用 zod 定義在 `packages/contracts`；團譜文件的 schema 從 `score-model` re-export。

### 3.1 登入與自己的帳號

| 方法與路徑 | 說明 |
|---|---|
| `POST /api/auth/login` | `{ username, password }` → 204，設定 session cookie。錯誤：401 `invalid_credentials`：帳號名稱不存在、密碼錯誤、帳號已停用都是這一個，不透露是哪一種（#5）；429 `rate_limited`，帶 `Retry-After` |
| `POST /api/auth/logout` | 刪除目前的 session，關閉這個 session 的 `/collab` 連線 |
| `POST /api/auth/logout-all` | 刪除這個帳號所有的 session，關閉它的所有連線 |
| `GET /api/me` | `{ accountId, username, displayName, isAdmin, mustChangePassword }`；沒有 session 時 401 |
| `PATCH /api/me` | `{ displayName }` |
| `POST /api/me/password` | `{ currentPassword?, newPassword }`；強制改密碼時不必 `currentPassword`。成功後 `mustChangePassword` 變成 false |

### 3.2 後台（只有 admin）

| 方法與路徑 | 說明 |
|---|---|
| `GET /api/admin/accounts` | 所有帳號：帳號名稱、顯示名稱、是否 admin、是否停用、綁定的登入方式 |
| `POST /api/admin/accounts` | `{ username, displayName, password }` → 201；帳號名稱重複時 409 `username_taken` |
| `POST /api/admin/accounts/:id/reset-password` | `{ password }`；刪除該帳號的所有 session、關閉連線 |
| `POST /api/admin/accounts/:id/disable`、`/enable` | 停用時刪除 session、關閉連線；不能停用自己（409 `cannot_disable_self`） |
| `GET /api/admin/orphaned-scores` | Owner 已停用的團譜：標題、Owner、啟用中的成員 |
| `POST /api/admin/scores/:id/transfer` | `{ accountId }`：只允許「Owner 已停用」且接收者是啟用中的現有成員 |
| `POST /api/admin/accounts/:id/identities` | M5：`{ provider: "karyl-chan", subject }`；同一個 `subject` 已綁到別的帳號時 409 `identity_taken` |
| `DELETE /api/admin/accounts/:id/identities/:identityId` | M5：解除綁定（不能解除密碼那一筆） |

### 3.3 團譜

| 方法與路徑 | 說明 | 角色 |
|---|---|---|
| `GET /api/scores` | `{ scores: [...] }`：我是成員的團譜，每一筆是 `id`、`title`、`artist`、`role`、`updatedAt`，依 `updatedAt` 由新到舊 | 任何帳號 |
| `GET /api/scores/deleted` | 我是 Owner、30 天內刪除的團譜 | 任何帳號 |
| `POST /api/scores` | `{ title, parts: [{ preset, count }], timeSig, tempo, bars }` → 201 `{ id }`。伺服器建立文件與初始內容（[`commands.md`](commands.md) 第 10 節）。#6 先只收 `{ title }`，內容固定是一個「吉他 6 弦」聲部、4/4、8 小節（速度不寫，讀作 120）；#11 加上其他欄位 | 任何帳號 |
| `POST /api/scores/import` | M5：`{ score: ScoreJSON }` → 201 `{ id }`。伺服器用 zod 驗證後以 `jsonToDoc` 建立（[`import-export.md`](import-export.md)） | 任何帳號 |
| `GET /api/scores/:id` | `{ id, title, artist, role, owner: { accountId, displayName } }` | 成員 |
| `POST /api/scores/:id/collab-ticket` | → `{ ticket, role }`（[`collab.md`](collab.md) 第 3 節） | 成員 |
| `DELETE /api/scores/:id` | 軟刪除 | Owner |
| `POST /api/scores/:id/restore` | 從「已刪除」還原 | Owner |
| `POST /api/scores/:id/transfer` | `{ accountId }`：轉移擁有權 | Owner |
| `POST /api/scores/:id/leave` | 離開團譜 | Editor、Viewer |

### 3.4 成員

| 方法與路徑 | 說明 | 角色 |
|---|---|---|
| `GET /api/scores/:id/members` | `accountId`、`username`、`displayName`、`role`、`disabled` | 成員 |
| `POST /api/scores/:id/members` | `{ username, role }`：加入成員。404 `account_not_found`、409 `already_member`、429 | Owner |
| `PATCH /api/scores/:id/members/:accountId` | `{ role: "editor" \| "viewer" }` | Owner |
| `DELETE /api/scores/:id/members/:accountId` | 移除成員 | Owner |

### 3.5 唯讀連結

| 方法與路徑 | 說明 | 角色 |
|---|---|---|
| `GET /api/scores/:id/link` | `{ token: string \| null }` | Owner |
| `POST /api/scores/:id/link` | 建立或重新產生 → `{ token }`；重新產生時關閉舊 token 的連線 | Owner |
| `DELETE /api/scores/:id/link` | 撤銷；關閉使用它的連線 | Owner |
| `POST /api/s/:token` | 訪客：→ `{ scoreId, title, ticket }`；token 錯誤一律 404（補充：用 POST，讓它經過 Origin 檢查） | 不必登入 |

### 3.6 版本

| 方法與路徑 | 說明 | 角色 |
|---|---|---|
| `GET /api/scores/:id/versions` | M5：`id`、`createdAt`、`reason`、`name`、`byteSize`，由新到舊 | 成員（補充） |
| `GET /api/scores/:id/versions/:versionId` | M5：遷移到目前版本的 `ScoreJSON` | 成員（補充） |
| `POST /api/scores/:id/versions` | 還原前存下伺服器當下的內容 → `{ versionId }`（[`collab.md`](collab.md) 8.5） | Owner、Editor |
| `PATCH /api/scores/:id/versions/:versionId` | M5：`{ name: string \| null }` | Owner、Editor（補充） |

### 3.7 樂句（M4）

| 方法與路徑 | 說明 |
|---|---|
| `GET /api/phrases` | 自己的樂句：`id`、`name`、`kind`、`stringCount`、`staffCount`、`barCount`、`updatedAt`、`revision`，依 `updatedAt` 由新到舊；可帶 `?kind=` 篩選、`?q=` 依名稱搜尋 |
| `POST /api/phrases` | `{ name, fragment }` → 201 `{ id, revision }`；空白樂句、「存成樂句」都用它 |
| `GET /api/phrases/:id` | `{ id, name, fragment, revision, updatedAt }` |
| `PUT /api/phrases/:id` | `{ fragment, baseRevision }` → `{ revision }`；409 `revision_conflict`、413 `phrase_too_large`（[`phrases.md`](phrases.md)） |
| `PATCH /api/phrases/:id` | `{ name, baseRevision }` → `{ revision }`：改名，同樣檢查 revision（補充） |
| `POST /api/phrases/:id/duplicate` | 複製一份 → 201 `{ id }`；名稱加上「（副本）」（補充） |
| `DELETE /api/phrases/:id` | 刪除 |

### 3.8 辨識（M4）

| 方法與路徑 | 說明 |
|---|---|
| `POST /api/recognitions` | `multipart/form-data`，欄位 `images`（1–15 張）→ 202 `{ id }`。409 `recognition_in_progress`（自己已有一件在跑）、503 `recognizer_busy`（伺服器上已有一件在跑，補充）、413、415 `unsupported_image` |
| `GET /api/recognitions` | 自己還沒存成樂句、也還沒捨棄的辨識（補充：讓 `/phrases` 列出「待審核」） |
| `GET /api/recognitions/:id` | `{ status: "running" \| "succeeded" \| "failed", error?, fragment?, report? }`；瀏覽器輪詢 |
| `GET /api/recognitions/:id/images/:page` | 原圖；只有發起的帳號可以讀 |
| `POST /api/recognitions/:id/save` | `{ name, fragment }` → 201 `{ phraseId }`：存成樂句，刪除原圖與這筆辨識 |
| `DELETE /api/recognitions/:id` | 捨棄：刪除這筆辨識與原圖 |

細節見 [`recognizer.md`](recognizer.md) 與 [`phrases.md`](phrases.md)。

- 樂句與辨識的 API 不分裝置。手機與平板上「只能看」是介面上的限制（[`views.md`](views.md) 第 7 節），伺服器不分辨裝置。

## 4. 錯誤代碼一覽（補充）

| code | HTTP | 意思 |
|---|---|---|
| `unauthenticated` | 401 | 沒有 session 或已失效 |
| `invalid_credentials` | 401 | 帳號名稱或密碼錯誤，或帳號已停用（三者不區分） |
| `password_change_required` | 403 | 要先改密碼 |
| `bad_origin` | 403 | Origin 檢查失敗 |
| `forbidden` | 403 | 是成員，但角色不夠 |
| `not_found` | 404 | 不存在，或不是成員（兩者不區分） |
| `account_not_found` | 404 | 加入成員時帳號名稱不存在 |
| `already_member`、`username_taken`、`identity_taken`、`cannot_disable_self`、`owner_cannot_leave` | 409 | |
| `revision_conflict` | 409 | 樂句的 `baseRevision` 不符 |
| `recognition_in_progress` | 409 | 自己已有一件辨識在跑 |
| `payload_too_large`、`phrase_too_large`、`score_too_large` | 413 | |
| `unsupported_image` | 415 | 不是 PNG、JPEG、WebP |
| `invalid_request` | 400 | zod 驗證失敗；`params.issues` 帶欄位路徑 |
| `limit_exceeded` | 422 | 超過聲部、小節等數量上限；`params` 帶上限名稱 |
| `rate_limited` | 429 | |
| `recognizer_busy` | 503 | 辨識服務忙碌中 |
| `internal_error` | 500 | 伺服器內部錯誤（細節只進 log） |
