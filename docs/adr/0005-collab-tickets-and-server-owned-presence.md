# `/collab` 用每次連線現取的一次性 ticket，在場的身分由伺服器決定

`/collab` 要同時接受兩種來源：帶 session cookie 的成員，以及持唯讀連結的訪客（ADR 0004）。而且有些帳號事件（被移除、被降級、登出、停用）發生時，已經開著的連線必須立刻斷掉，不能等它自己重連。我們的做法：

- **每次連線現取一張 ticket。** 成員帶 cookie 呼叫 `POST /api/scores/:id/collab-ticket`；訪客呼叫 `POST /api/s/:token`，拿到團譜 id 與 ticket。ticket 有效 60 秒、只能用一次，內容是「帳號（與 session）或連結 token」、團譜 id 與角色。provider 的 `token` 一律傳**函式**，每次連線與重連都重新取一張；傳固定字串的話，重連時會失敗。
- **WebSocket 的 upgrade 不使用 cookie。** 所以不必處理跨站 WebSocket 劫持（CSWSH），也不必在 upgrade 時檢查 Origin。
- **Viewer 與訪客的連線是 `readOnly`。** Hocuspocus 會丟棄它們送來的 Update 與 SyncStep2（`hocuspocus-server.esm.js:268-290`）。
- **在場的身分由伺服器寫。** Awareness 不受 readOnly 影響，所以在 `beforeHandleAwareness` 裡，用連線的 context 覆寫 `accountId`、`displayName`、`color`，並移除訪客的狀態；修改後的狀態會被重新編碼再套用（:196-215）。訪客也收不到別人的在場：Hocuspocus 會把 awareness 廣播給同一份文件的每一條連線（:675-677，連線建立時另有 `sendCurrentAwareness`，:434-438），所以伺服器在訪客連線的 socket 上丟掉送出的 awareness 訊息。
- **伺服器主動斷線。** 伺服器記住每條連線的帳號、session 與連結 token。成員被移除或降級、登出、改密碼、被重設密碼、帳號停用、唯讀連結被撤銷或重新產生、團譜被刪除時，只關閉相關的連線。不能用 `closeConnections(documentName)`，它會關掉整份文件的所有連線（`index.d.ts:207`）。

考慮過、沒採用的做法：

- **upgrade 時讀 session cookie。** 要另外擋 CSWSH；而且訪客沒有 cookie，還是需要第二種驗證方式。
- **長期有效的 token 放在 WebSocket 網址或 provider 參數裡。** 會留在 log 與瀏覽器裡，外洩後可以重放；而且撤銷時仍然要伺服器主動斷線。
- **相信客戶端送來的 awareness。** 任何 Editor 都能冒用別人的名字與顏色，訪客也會出現在成員的畫面上。
- **權限變動時用 `closeConnections(documentName)`。** 會把整份文件的其他人一起踢掉。

## Consequences

- 每次重連都要先打得通 API。取 ticket 回 401 或 404，或拿到的角色比原本低時，客戶端丟掉本機的 `Y.Doc`，以唯讀重新載入並提示；本機未同步的修改放棄。只切換介面不夠，因為本機文件已經和伺服器分歧了。
- ticket 的回應帶著角色，客戶端靠它發現自己被降級。
- 伺服器要維護一份「連線 → 帳號、session、連結 token」的對照表；每個會改變權限的 API 都要記得呼叫斷線。
- 細節見 `docs/spec/collab.md` 與 `docs/spec/security.md`。
