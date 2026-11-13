# karyl-chan bot 登入（M5）

依據 karyl-chan 的 `packages/bot/docs/features/service-login.md`。這個功能已經在 bot 的 `main` 上（最後修改 2026-11-11 的 `a7c9e3c`），不需要改 bot 的 repo；也不得改它。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 流程

1. 成員私訊 bot（預設 `!login-<audience>`），bot 回一個一次性的連結：`<redirect URL>?token=<service token>`，有效 120 秒（文件 :65）。
2. 瀏覽器打開 `GET /auth/karyl?token=…`。
3. 伺服器驗證 token（第 2 節），找出綁定的帳號，建立 session，然後 302 轉到 `/`。

- `GET /auth/karyl` 是 **Fastify 的伺服器路由**，不是 vue-router 的頁面。token 不會進到 SPA 的 JavaScript 與瀏覽器歷史（文件 :59-61）。
- nginx 範例設定對這個路徑關掉 `access_log`，否則 token 會留在 log 裡。
- 伺服器的 request log 也要遮掉 `token` 參數（[`security.md`](security.md)）。

## 2. 驗證步驟

全部必做（文件 :92-115），用 `jose` 函式庫（範例在 :128-149）：

1. header 的 `alg` 是 `EdDSA`、`typ` 是 `karyl-service+jwt`，而且必須有 `kid`。
2. 從 `<iss>/.well-known/jwks.json` 取金鑰；遇到不認得的 `kid`，重新抓一次金鑰組。不得退回「金鑰組裡唯一的那一把」。
3. 驗證 Ed25519 簽章。
4. `aud` 等於設定的 audience。
5. `iss` 等於設定的值，不能取 token 裡的。
6. `exp` 還沒過期，時鐘誤差最多 5 秒。
7. `jti` 沒有用過：用 Redis `SET NX` 記錄，TTL 到 `exp` 加上時鐘誤差為止。防重放是 service 自己的責任。

- `jose` 的寫法：`createRemoteJWKSet(new URL(`${iss}/.well-known/jwks.json`))`，`jwtVerify(token, jwks, { algorithms: ["EdDSA"], typ: "karyl-service+jwt", audience, issuer, clockTolerance: 5, requiredClaims: ["sub", "jti", "exp"] })`。
- 驗證通過之後，`sub` 是登入者的 Discord id。

## 3. 設定

- `iss` 與 audience 用環境變數設定。**補充**：`KARYL_ISSUER`（bot 的公開網址，結尾不帶 `/`）與 `KARYL_AUDIENCE`。兩者沒有設定時，`/auth/karyl` 回 404，登入頁也不顯示 karyl-chan 的說明。
- redirect URL 必須是 https（文件 :37），所以本機做不到真實的往返。
- 在 bot 的 `/admin/services` 註冊 service（名稱、audience、redirect URL `https://<studio 的 host>/auth/karyl`）是**人工步驟**。

## 4. 綁定

- admin 在 `/admin` 把 Discord id 綁到既有帳號，存成 `identities.provider = 'karyl-chan'`、`subject` 是 Discord id（[`accounts.md`](accounts.md)）。
- **補充**：一個 Discord id 只能綁一個帳號；一個帳號最多綁一個 Discord id。
- 未綁定的 Discord id 一律拒絕：不自動建帳號，不建立 session。畫面顯示對方的 Discord id（token 的 `sub`），方便交給 admin。
- 綁定的帳號已停用：拒絕，不建立 session。
- karyl 登入不受「強制改密碼」約束。

## 5. 失敗時的畫面（補充）

`/auth/karyl` 是伺服器路由，SPA 讀不到它的結果。做法：

- 失敗時 302 轉到 `/login`，同時設一個短期 cookie `__Host-karyl_result`（`Secure`、`Path=/`、`SameSite=Lax`、`Max-Age=60`，**不是** `HttpOnly`，讓 SPA 讀得到），值是 `unbound:<Discord id>`、`disabled` 或 `invalid` 之一。走 http 的開發與測試環境改用不帶前綴、不帶 `Secure` 的 `karyl_result`，和 session cookie 用同一個設定（[`security.md`](security.md) 第 1 節）。
- `/login` 讀到這個 cookie 就顯示對應的訊息（未綁定時顯示 Discord id），然後立刻刪掉它。
- 不把 Discord id 放在網址裡。
- 成功時不設這個 cookie。

## 6. 測試

- 自動測試用本機產生的 Ed25519 金鑰與假的 JWKS 端點。
- 要涵蓋第 2 節的每一個失敗情況（錯的 `alg`、錯的 `typ`、沒有 `kid`、不認得的 `kid` 觸發重抓、簽章錯、`aud` 錯、`iss` 錯、過期、重放），以及未綁定、已停用的帳號。
