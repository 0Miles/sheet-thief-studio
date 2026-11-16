# 帳號、管理者、成員、角色、唯讀連結、刪除團譜

標「補充」的是 spec 撰寫者保守補上的細節。安全相關的數字見 [`security.md`](security.md)，API 見 [`routes.md`](routes.md)。

## 1. 帳號

- 帳號只由管理者在 `/admin` 建立，不開放註冊（ADR 0004）。
- **帳號名稱**：小寫英數、`-`、`_`，長度 3–32，建立後不能改，全站唯一。
- **顯示名稱**：本人可以在 `/account` 改。**補充**：1–50 字元，前後空白去掉。
- **密碼**：argon2id；長度 10–256 字元；沒有組成規則（[`security.md`](security.md)）。
- **強制改密碼**：首次登入、以及被重設密碼之後，強制改密碼（`/account/password` 的 router guard）；只適用於密碼登入，karyl-chan 登入不受約束。
  - **補充**：強制改密碼的頁面只要求新密碼（輸入兩次），因為剛用暫時密碼登入；在 `/account` 自己改密碼時，要先輸入目前的密碼。
- **停用的帳號**仍然是成員，名稱旁顯示「已停用」；不能登入。
- 不做帳號刪除。
- 不做自助的「忘記密碼」：由管理者重設（ADR 0004）。
- **登出所有裝置**（`/account`）：刪除這個帳號所有的 session，並關閉它的所有 `/collab` 連線。

### 1.1 登入方式

- 登入方式另外存在 `identities` 表：`provider` 是 `'password'` 或 `'karyl-chan'`，`subject` 是對方系統裡的 id（ADR 0004）。
- **補充**：密碼也是一筆 identity：`provider = 'password'`、`subject` 是帳號 id、`secret_hash` 是 argon2id 雜湊。`(provider, subject)` 唯一。
- karyl-chan 的綁定見 [`karyl-login.md`](karyl-login.md)。

### 1.2 資料表（補充：欄位草案）

| 表 | 欄位 |
|---|---|
| `accounts` | `id`、`username`（唯一）、`display_name`、`is_admin`、`disabled_at`、`must_change_password`、`created_at`、`updated_at` |
| `identities` | `id`、`account_id`、`provider`、`subject`、`secret_hash`（只有密碼有）、`created_at`；`(provider, subject)` 唯一 |
| `score_members` | `score_id`、`account_id`、`role`（`'owner'`、`'editor'`、`'viewer'`）、`added_at`；`(score_id, account_id)` 唯一；每份團譜恰好一個 `owner`（partial unique index） |

`scores` 表見 [`collab.md`](collab.md)。用 Sequelize 與 umzug 遷移。

## 2. Admin（管理者）

- Admin 是 Account 上的旗標 `accounts.is_admin`，和團譜的 Owner 無關。
- 第一個 admin 用伺服器上的 CLI 指令建立（ADR 0004）。**補充**：`pnpm --filter @studio/server cli create-admin <帳號名稱> <顯示名稱>`，密碼從標準輸入讀，不放在指令列。
- **補充**：CLI 建立的 admin 的密碼是自己在伺服器上設的，不是別人給的暫時密碼，所以 `must_change_password = false`，首次登入不強制改密碼（#5）。第 1 節的強制改密碼適用於 admin 在 `/admin` 建立的帳號，以及被重設密碼的帳號。
- **補充**：`is_admin` 只能用 CLI 設定或取消（`cli grant-admin <帳號名稱>`、`cli revoke-admin <帳號名稱>`），`/admin` 不能改，避免網頁上的 admin 互相拔除或鎖住自己。
- Admin 能做的事**只有這些**：
  1. 建立帳號：帳號名稱、顯示名稱、初始密碼。新帳號 `must_change_password = true`。
  2. 重設密碼：設定新的暫時密碼，並設 `must_change_password = true`。
  3. 停用、啟用帳號。**補充**：不能停用自己。
  4. 綁定、解除其他登入方式（M5，karyl-chan）。
  5. **唯一的例外**：某份團譜的 Owner 已經停用時，admin 可以在 `/admin` 把擁有權轉給那份團譜一名**啟用中**的現有成員。沒有其他啟用中的成員時，團譜維持原狀。
- Admin 對別人的團譜沒有其他任何權限：不能開啟、不能看內容、不能改成員。
- **補充**：`/admin` 的「已停用 Owner 的團譜」列表只顯示團譜標題、Owner 與啟用中的成員名單，不顯示內容。
- 停用帳號或重設密碼時：刪除該帳號所有的 Redis session，並關閉它的 `/collab` 連線。

## 3. 角色與權限

| 角色 | 可以做的事 |
|---|---|
| **Owner** | 唯一。建立團譜時是建立者；擁有權轉移後是接收的那個人。Editor 能做的全部，加上：管理成員、管理唯讀連結、刪除團譜、還原已刪除的團譜、把擁有權轉給一名現有成員（之後原 Owner 變成 Editor） |
| **Editor** | 所有 Command（包含增刪聲部與小節、改標題）、剪下、貼上、放置、還原版本，以及 Viewer 能做的全部 |
| **Viewer** | 檢視、播放、匯出、複製、存成樂句 |

- Editor 與 Viewer 可以自己離開團譜。
- 任何帳號都可以建立團譜，建立者成為 Owner。
- 非成員打開 `/scores/:id` 回 404，不回 403。

### 3.1 完整的權限表

「訪客」是持唯讀連結、沒有登入的人。「非成員」包含 admin：admin 旗標不給任何團譜權限。

| 動作 | Owner | Editor | Viewer | 訪客 | 非成員 |
|---|---|---|---|---|---|
| 在「我的團譜」看到這份團譜 | ✓ | ✓ | ✓ | — | — |
| 開啟、檢視、播放 | ✓ | ✓ | ✓ | ✓（Read view） | 404 |
| 用混音、節拍器、預備拍（本機） | ✓ | ✓ | ✓ | ✓ | — |
| 看 Presence、出現在 Presence | ✓ | ✓ | ✓ | — | — |
| 移動游標、選取（桌面） | ✓ | ✓ | ✓ | — | — |
| 複製 | ✓ | ✓ | ✓ | — | — |
| 存成樂句 | ✓ | ✓ | ✓ | — | — |
| 匯出 GP7、MIDI（M5） | ✓ | ✓ | ✓ | —（介面沒有按鈕，不是安全邊界） | — |
| 所有 Command：打譜、技巧、結構操作、聲部管理、改標題與演出者 | ✓ | ✓ | — | — | — |
| 剪下、貼上、放置樂句 | ✓ | ✓ | — | — | — |
| 看版本列表、預覽版本（M5，補充） | ✓ | ✓ | ✓ | — | — |
| 命名版本（M5，補充） | ✓ | ✓ | — | — | — |
| 還原版本 | ✓ | ✓ | — | — | — |
| 看成員名單（補充） | ✓ | ✓ | ✓ | — | — |
| 加入成員、改角色、移除成員 | ✓ | — | — | — | — |
| 建立、複製、重新產生、撤銷唯讀連結 | ✓ | — | — | — | — |
| 轉移擁有權 | ✓ | — | — | — | — |
| 刪除團譜、在 30 天內還原 | ✓ | — | — | — | — |
| 離開團譜 | —（要先轉移擁有權，補充） | ✓ | ✓ | — | — |
| 轉移「Owner 已停用」的團譜 | — | — | — | — | 只有 admin（第 2 節） |

## 4. 加入成員

- Owner 輸入**完整的帳號名稱**，把一個已存在的帳號加入為成員，並選角色（Editor 或 Viewer；補充：預設 Editor）。
- 沒有待接受的狀態，沒有通知，沒有 email，沒有邀請實體。詞彙用「加入成員」，「invitation」列為 Avoid。
- 不提供帳號名錄，也不做名稱的自動完成。
- 帳號名稱不存在：回 404 `account_not_found`。查詢有速率限制，因為它可以用來探測帳號存不存在（數字見 [`security.md`](security.md)）。
- **補充**：已經是成員時回 409 `already_member`；可以加入停用的帳號（他仍然不能登入）。
- **改角色**：Owner 可以把成員在 Editor 與 Viewer 之間切換。降級時，伺服器關閉該成員對這份團譜的 `/collab` 連線；客戶端重連時拿到較低的角色，丟掉本機文件並以唯讀重新載入（[`collab.md`](collab.md)）。
- **移除成員**：Owner 可以移除任何非 Owner 的成員；伺服器關閉該成員對這份團譜的連線。

## 5. 轉移擁有權

- Owner 在 `/scores/:id/settings` 把擁有權轉給一名現有成員（Editor 或 Viewer）。**補充**：對方必須是啟用中的帳號；轉移前跳確認對話框。
- 轉移後，對方成為 Owner，原 Owner 變成 Editor。一筆資料庫交易完成。
- **補充**：雙方的角色都改變了，伺服器關閉兩人對這份團譜的 `/collab` 連線，讓他們以新的角色重連（原 Owner 變成 Editor 仍可編輯，不必丟掉本機文件）。
- Admin 的例外轉移見第 2 節；接收者同樣要是啟用中的現有成員，原 Owner（已停用）變成 Editor。
- owner 在 2026-11-13 確認兩種轉移都保留（[`README.md`](README.md) 的「owner 的裁定」）。

## 6. 離開團譜

- Editor 與 Viewer 可以在 `/scores/:id/settings` 自己離開。**補充**：離開前跳確認對話框；離開後伺服器關閉他對這份團譜的連線，畫面回到 `/`。
- Owner 不能離開，要先轉移擁有權（補充）。

## 7. 唯讀連結

- 每份團譜最多一條有效連結，網址 `/s/<token>`；token 是至少 128 bit 的亂數。**補充**：用 32 bytes 的亂數，以 base64url 編碼（43 個字元）。
- token 以明文存在資料庫（補充：`scores.link_token`，唯一、可以是 null），Owner 可以再次複製。代價：資料庫外洩時連結跟著外洩；內容本來就是唯讀，而且可以撤銷。
- 「重新產生」就是撤銷舊的、產生新的。
- 撤銷或重新產生時，立刻關閉使用舊 token 的所有連線。
- 訪客透過伺服器強制唯讀的 `/collab` 看到即時內容；Presence 規則見 [`views.md`](views.md)。
- 訪客沒有匯出按鈕。這只是介面上的限制，不是安全邊界：訪客的瀏覽器裡已經有完整的內容。
- `/s/` 與 `/api/s/` 的回應帶 `Referrer-Policy: no-referrer` 與 `X-Robots-Tag: noindex`；token 錯誤一律回 404。
- 團譜被刪除時，token 被清掉；還原後不會自動恢復，要由 Owner 重新產生。

## 8. 刪除團譜（軟刪除）

- Owner 刪除團譜時，設定 `scores.deleted_at`；之後所有人都打不開（404）。**補充**：刪除前跳確認對話框。
- 伺服器立刻關閉這份團譜的所有 `/collab` 連線，並清掉唯讀連結的 token。
- 成員關係保留到永久刪除為止；被刪除的團譜不出現在任何人的「我的團譜」。
- Owner 可以在 30 天內，從 `/` 的「已刪除」區塊還原；只有 Owner 看得到這個列表。還原後一切照舊，只有唯讀連結要重新產生。
- 超過 30 天，由 server 行程內的定時工作連同版本一起永久刪除。只有一個行程，所以沒有多實例的問題（ADR 0001）。**補充**：定時工作每小時跑一次，也在 server 啟動時跑一次。
- **補充**（#15）：30 天從 `deleted_at` 起算（`DELETED_SCORE_DAYS`，在 contracts），一律以**資料庫**的時鐘為準：`deleted_at` 寫的是 `now()`，列表、還原與永久刪除都拿 `now() - 30 天` 來比，不看 server 行程的時鐘（永久刪除無法復原，行程時鐘誤跳的代價太高）。滿 30 天之後、定時工作還沒跑到之前，這份團譜已經不在「已刪除」列表，也不能還原。定時工作只刪 `scores` 裡 `deleted_at` 早於 30 天前的資料列；成員與版本靠外鍵的 `ON DELETE CASCADE` 一起刪除，所以之後每一張指向 `scores` 的表都要設這個外鍵。某一次執行失敗時寫 error log，下一個小時再試。
- **補充**（#15）：刪除與還原都不更新 `updated_at`；還原後團譜在「我的團譜」的排序和刪除前一樣。刪除時以 `Forbidden` 關閉連線（[`collab.md`](collab.md) 第 6 節）。
- **補充**（#15，host 在 2026-11-16 的裁定）：刪除當下還沒存進資料庫的修改不丟掉。連線被關閉時 Hocuspocus 做最後一次儲存，`doc_state` 與 `title`、`artist` 照寫，但已刪除的團譜不更新 `updated_at`。這次儲存之後文件從記憶體卸載，已刪除的資料列不再有任何寫入，直到還原。
- **補充**（#15）：已刪除的團譜不能產生或撤銷唯讀連結：和刪除同時送到的請求，在鎖住資料列之後發現團譜已刪除，回 404、不寫入。還原時再清一次 `link_token`。
- owner 在 2026-11-13 確認保留軟刪除（[`README.md`](README.md) 的「owner 的裁定」）。

## 9. 伺服器主動斷線的時機

伺服器記住每條連線對應的帳號、session 或連結 token（ADR 0005）。以下情況只關閉相關的連線，不用 `closeConnections(documentName)`：

| 事件 | 關閉哪些連線 |
|---|---|
| 成員被移除或降級 | 該帳號對這份團譜的連線 |
| 擁有權轉移 | 原 Owner 與新 Owner 對這份團譜的連線（補充） |
| 成員自己離開 | 該帳號對這份團譜的連線 |
| 登出 | 該 session 開出的連線（補充：以 session 為準，其他裝置不受影響） |
| 登出所有裝置、改密碼、被重設密碼、帳號停用 | 該帳號的所有連線 |
| 唯讀連結被撤銷或重新產生 | 使用舊 token 的連線 |
| 團譜被刪除 | 這份團譜的所有連線 |

- **補充**：自己改密碼時，刪除這個帳號其他所有的 session，保留目前這一個；目前分頁的連線也會被關閉，然後用新的 ticket 自動重連。
