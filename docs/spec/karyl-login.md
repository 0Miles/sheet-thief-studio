# karyl-chan plugin 與登入（M5）

owner 在 2026-11-18 裁定（#72 的留言「方向變更」）：studio 做成 karyl-chan 的 plugin，掛在 bot 底下，取代原本只做 service-login（`karyl-service+jwt`）的做法。依據 karyl-chan 的 `packages/bot/docs/development/plugin-guide.md`、`packages/plugin-sdk/README.md` 與 `packages/plugin-example`；bot 的 repo 不得修改。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 流程

1. 成員在 Discord 打 slash command `/studio`。bot 把指令轉給 plugin。
2. plugin 用 `ctx.auth.mintSession({ userId, kind: "session", ttlMs: 120000 })` 向 bot 要一個 `plugin-session` JWT，再回一則只有本人看得到的訊息，內容是連結 `<publicBaseUrl>/auth/karyl?token=<JWT>`。連結 2 分鐘內有效，只能用一次。
3. 瀏覽器打開連結。bot 的代理把 `/plugin/<key>` 去掉，轉給 studio 的 `GET /auth/karyl?token=…`。
4. 伺服器驗證 token（第 2 節），找出綁定的帳號（第 4 節），建立 session，然後 302 轉到 `../#session=<session id>`，也就是 `<base>/`。
5. 頁面從 fragment 取出 session id 存起來，立刻用 `history.replaceState` 把 fragment 從網址拿掉；之後的 API 請求都帶 `Authorization: Bearer <session id>`。

- `GET /auth/karyl` 是 **Fastify 的伺服器路由**，不是 vue-router 的頁面。JWT 不會進到 SPA 的 JavaScript；302 之後瀏覽器歷史記的是轉過去的網址，不是連結。
- 轉址用相對路徑（`../`）：伺服器看不到 bot 代理去掉的前綴，相對路徑讓瀏覽器留在 `/plugin/<key>/` 底下。
- session id 放在 fragment：fragment 不會送到任何伺服器，也不會進 log。
- **補充**：bot 的 plugin-session JWT 沒有 `jti`；同一人在同一秒內打兩次 `/studio`，兩個 token 會一模一樣，第二個連結就算用過了，再打一次指令即可。

## 2. 驗證

- 用 SDK 的 `verifyPluginSession(token, sessionVerifyPublicKey)` 離線驗證：header 必須是 `{ alg: "EdDSA", typ: "JWT" }`、Ed25519 簽章正確、`purpose` 是 `plugin-session`、`exp` 還沒過、`userId` 是字串。公鑰由 bot 在 register 與每次 heartbeat 時送來，key rotation 大約 30 秒內生效。
- 還沒向 bot 註冊成功、手上沒有公鑰時，所有連結都失敗（`invalid`）。
- **只能用一次**（補充）：驗證通過後，用 Redis `SET karyl-login-used:<token 的 SHA-256> NX`，TTL 到 `exp` 加 5 秒（bot 的時鐘可能快一點）。已經用過的 token 視為 `invalid`。理由：連結的網址可能留在 bot 代理的 log 或別的地方，用過一次就作廢。
- 驗證通過之後，`userId` 是登入者的 Discord id。

## 3. plugin 與設定

- plugin key 是 `sheet-thief-studio`；manifest 宣告 `/studio` 指令（`scope: "global"`、`guild_install`、只在伺服器頻道裡用，回覆預設 ephemeral）與 `rpcMethodsUsed: ["auth.session"]`。
- 設了 `KARYL_PLUGIN_SETUP_SECRET`（bot 的 admin 在 `/admin/plugins` 發的 setup secret）才進 plugin 模式；沒設時是獨立部署，`/auth/karyl` 回 404。
- `BOT_URL`：bot 在 Docker 網路上的位址；`PLUGIN_URL`：bot 連到 studio 的位址（dispatch 與頁面代理都送到這裡）。plugin 模式下兩者在正式環境必須設定；開發時預設 `http://localhost:3000` 與 `http://localhost:<PORT>`。
- `PUBLIC_ORIGIN` 是 bot 的公開 origin：頁面由 bot 的網域送出，瀏覽器的 `Origin` 是它。
- `TRUSTED_PROXIES` 要包含 bot 在 Docker 網路上的位址：站在 studio 前面的是 bot 的代理，用戶端的 IP（速率限制用）在它加的 `X-Forwarded-For` 裡。
- SDK 的 `start()` 會自己開一個 Fastify 並 listen。**補充**：讓它只聽 loopback 的隨機 port；bot 送到 `PLUGIN_URL` 的 `POST /commands/*`、`GET /health`、`GET /health/*` 由 studio 的 Fastify 原封不動（body 照原本的位元組，HMAC 簽的是它）用 `inject` 轉給 SDK 的 server。這樣 `PLUGIN_URL` 只有一個，studio 的 logger、Origin 檢查與安全標頭都不變。這幾條路由沒有 Origin 檢查（不是瀏覽器送的），改由 SDK 驗 HMAC。
- 伺服器先 listen，再向 bot 註冊；註冊失敗時 SDK 在背景重試，不擋住伺服器啟動。
- SDK 自己處理 `SIGTERM`、`SIGINT`：停掉 plugin（向 bot deregister）後結束 process。
- 在 bot 建立 plugin（取得 setup secret）與啟用 plugin 是**人工步驟**；部署設定（`karyl-chan-net`、setup secret、`BOT_URL`、`PLUGIN_URL`）在 #73。

## 4. 綁定

- plugin 模式下沒有人能用密碼登入，所以第一個 admin 先在伺服器上用 CLI `bind-discord <帳號名稱> <Discord ID>` 綁定自己（[`accounts.md`](accounts.md) 第 2 節）。
- admin 在 `/admin` 把 Discord id 綁到既有帳號，存成 `identities.provider = 'karyl-chan'`、`subject` 是 Discord id（[`accounts.md`](accounts.md)；API 見 [`routes.md`](routes.md) 3.2）。Discord id 是 17 到 20 位數字。
- **補充**：一個 Discord id 只能綁一個帳號；一個帳號最多綁一個 Discord id。兩種衝突都回 409 `identity_taken`。綁定時鎖住帳號那一列，同時兩個綁定只會成功一個。
- 解除綁定之後，那個 Discord id 的連結不再能登入，而且這個帳號用 karyl-chan 登入的 session 全部結束（連同它們的 `/collab` 連線）；用密碼登入的 session 不受影響。密碼那一筆 identity 不能解除（400 `invalid_request`）。
- 未綁定的 Discord id 一律拒絕：不自動建帳號，不建立 session。`/login` 顯示對方的 Discord id，方便交給 admin。
- 綁定的帳號已停用：拒絕，不建立 session。
- karyl 登入的 session 不受「強制改密碼」約束（`via: 'karyl-chan'`，[`security.md`](security.md) 第 1 節）。

## 5. Session 與 Bearer token

- bot 的代理會刪掉請求的 `cookie` 標頭，回應的 `Set-Cookie` 則改寫 Path，所以 plugin 模式不能用 cookie session。
- `/api/*` 除了 session cookie，也接受 `Authorization: Bearer <session id>`；兩個都有時用 Bearer。session 本身與 cookie 的一樣（Redis、sliding 30 天）。用 Bearer 的請求不會收到 `Set-Cookie`，401 時也不清 cookie。
- `POST /api/auth/logout` 結束 Bearer 指的那一個 session。
- 頁面把 session id 存在 `localStorage`，鍵是 `studio:session:<base path>`，讓同一個瀏覽器的其他分頁也登入；API 回 401 `unauthenticated` 時刪掉它，登出時也刪掉。
- 辨識的原圖不用 `<img src>` 直接指向 API（圖片自己的請求不會帶 Bearer），改用帶 Bearer 的請求取得內容，再顯示成 object URL（CSP 的 `img-src` 已有 `blob:`）。CSP 的 `script-src 'self'` 是對 XSS 的防線（[`security.md`](security.md) 第 7 節）。
- 共編：collab ticket 本來就是 WebSocket 握手的 token（ADR 0005）。頁面帶 Bearer 取 ticket，再連 `<base>/collab`；bot 的代理會轉發 Upgrade（karyl-chan/karyl-chan#271）。
- 獨立部署照舊：帳號密碼登入，session 放在 cookie。plugin 模式下密碼登入的 cookie 到不了伺服器，所以 `/login` 只顯示 karyl-chan 的說明。頁面以「base path 不是 `/`」判斷自己由 bot 送出。

## 6. 頁面在 base path 底下

- bot 把 plugin 的頁面放在 `<WEB_BASE_URL>/plugin/<key>/`，register 與 heartbeat 的回應帶 `publicBaseUrl`。base path 取它的路徑；bot 沒有設 `WEB_BASE_URL` 時用 `/plugin/<key>/`，連結的網址用 `PUBLIC_ORIGIN` 加上這個路徑。
- 伺服器送出 `index.html` 時，把 `<base href="/">` 換成 `<base href="<base path>">`（build 裡沒有 `<base>` 時，插在 `<head>` 的最前面），ETag 依換過的內容計算。獨立部署（base path 是 `/`）照原樣送出 build 的檔案。
- 頁面的 router、API、`/collab` 與 alphaTab 的字型、音色庫，都從 `document.baseURI` 算路徑（`apps/web/src/served.ts`）；唯讀連結的網址也是。Vite 用 `base: "./"` 打包，`index.html` 帶 `<base href="/">`。
- CSP 的 `base-uri` 是 `'self'`，允許頁面自己的 `<base>`（[`security.md`](security.md) 第 7 節）。studio 自己送 CSP，蓋過 bot 預設的那一個。

## 7. 失敗時的畫面

`/auth/karyl` 是伺服器路由，SPA 讀不到它的結果。

- 失敗時 302 轉到 `../login#karyl=<原因>`，原因是 `unbound:<Discord id>`、`disabled`、`invalid`、`rate_limited` 之一。
- `/login` 讀到這個 fragment 就顯示對應的訊息（未綁定時顯示 Discord id），然後立刻用 `history.replaceState` 拿掉 fragment。
- 不用 cookie：bot 的代理改寫 `Set-Cookie` 的 Path，`__Host-` cookie 會被瀏覽器拒絕。fragment 不會送到伺服器，也不進 log。
- 速率限制見 [`security.md`](security.md) 第 4 節；超過時是 `rate_limited`。

## 8. 測試

- server vitest 用本機產生的 Ed25519 金鑰簽 `plugin-session` token：合法的 token 建立 session 並轉到 `../#session=…`；別的金鑰簽的、過期的、`purpose` 不對的、`alg` 不對的、簽章被截掉的、不是 token 的、沒帶 token 的都被拒；同一個 token 第二次被拒；還沒註冊（沒有公鑰）時被拒；未綁定、已停用的帳號被拒；速率限制。
- 用一個假的 bot（register、heartbeat、`auth.session`、`interactions.respond`）跑完整的一圈：plugin 註冊並送出 manifest；bot 簽名的 `/studio` dispatch 經過 studio 的伺服器到 SDK；回覆的連結能登入。沒有簽名的 dispatch 被拒。
- Bearer session 能取 collab ticket 並連上 `/collab`。
- 綁定、解除綁定的 API 與 CLI；`/admin` 的綁定與解除綁定（Playwright e2e，`admin.spec.ts`）。
- web 的單元測試（`apps/web/tests/served.test.ts`）：base path 底下的 API、`/collab` 與 alphaTab 檔案的路徑，fragment 的 session 與失敗原因，Bearer 的帶上與遺忘。
- Playwright project `plugin`：一個假的 bot 代理頁面，用 `/studio` 的連結登入並在 base path 底下共編（[`testing.md`](testing.md) 第 3 節）。
- 真實 bot 的往返是人工步驟（[`testing.md`](testing.md) 第 6 節）。
