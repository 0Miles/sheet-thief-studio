# 安全基線

Cookie、session、Origin、速率限制、密碼、大小上限、CSP、回應標頭、404 規則。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. Cookie 與 session

- Session cookie：`__Host-` 前綴，`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`，不設 `Domain`。**補充**：名稱是 `__Host-studio_session`。
- Session 存在 Redis，sliding 30 天：每次帶著有效 session 的請求，把到期時間延長成 30 天後。
- **補充**：session id 是 32 bytes 的亂數（base64url）。Redis 鍵 `session:<id>` 存 `{ accountId, createdAt }`；另有集合 `account-sessions:<accountId>`，用來刪除一個帳號的所有 session。
- 登入成功時換一個新的 session id（避免 session fixation，補充）。
- 停用帳號或重設密碼時，刪除該帳號所有的 Redis session，並關閉它的 `/collab` 連線（[`accounts.md`](accounts.md)）。
- **開發與測試環境的例外**：走 http 的開發與測試環境（`http://localhost`、區網的實機測試）可以用環境變數改用不帶前綴、不帶 `Secure` 的 cookie 名稱，做法同前身 `app/config.py` 的 `cookie_secure`。**補充**：環境變數是 `INSECURE_COOKIES=1`；名稱是 `studio_session` 與 `karyl_result`（[`karyl-login.md`](karyl-login.md) 第 5 節的 cookie 也跟著同一個設定）。
  - WebKit（Safari）在 http 上不接受 `__Host-` cookie，所以 CI 的 WebKit 打譜 smoke、在 Mac 上用 Safari 開發，以及手機的區網實機測試都要用這個設定（owner 在 2026-11-13 裁定桌面 Safari 要能打譜）。
  - Firefox 要不要用，看 [`testing.md`](testing.md) 第 5 節確認檢查 1 的結果。
  - `NODE_ENV=production` 時這個設定不生效；正式環境一律用 `__Host-` 名稱。

## 2. Origin 檢查

- 所有非 GET（`POST`、`PUT`、`PATCH`、`DELETE`）的 `/api/*` 請求都檢查 `Origin`：必須等於設定的公開 origin（環境變數 `PUBLIC_ORIGIN`）。沒有 `Origin` 標頭也拒絕。拒絕時回 403 `bad_origin`。做法同前身 `app/security.py` 的 `OriginCheckMiddleware`。
- WebSocket upgrade 不使用 cookie，驗證靠 collab ticket，所以不做 Origin 檢查（ADR 0005）。

## 3. 密碼

- argon2id。**補充**：參數 `memoryCost = 19456`（KiB）、`timeCost = 2`、`parallelism = 1`。
- 長度 10–256 字元，沒有組成規則。owner 在 2026-11-13 確認。
- 自己改密碼時要輸入目前的密碼；強制改密碼的頁面不必（[`accounts.md`](accounts.md)）。

## 4. 速率限制

計數存在 Redis，以固定的 15 分鐘或 1 分鐘視窗計算（補充）。超過時回 429 `rate_limited`，帶 `Retry-After`。

| 對象 | 限制 | 來源 |
|---|---|---|
| 登入（`POST /api/auth/login`） | 同一帳號名稱、同一 IP，各自 15 分鐘內最多 10 次。代價：別人可以故意把某個成員鎖住 15 分鐘 | 設計決定；owner 已確認數字 |
| 加入成員的帳號名稱查詢（`POST /api/scores/:id/members`） | 同一帳號 15 分鐘內最多 20 次 | 補充 |
| 自己改密碼（`POST /api/me/password`） | 同一帳號 15 分鐘內最多 10 次（防止拿到 session 的人猜目前的密碼） | 補充 |
| 訪客取 ticket（`POST /api/s/:token`） | 同一 IP 每分鐘最多 30 次 | 補充 |
| 成員取 ticket（`POST /api/scores/:id/collab-ticket`） | 同一帳號每分鐘最多 60 次 | 補充 |
| karyl-chan 登入（`GET /auth/karyl`） | 同一 IP 15 分鐘內最多 10 次 | 補充 |
| 其他 API | 不另設限制：平台只對登入的成員開放，辨識另有「每個帳號同時一件」的限制 | 補充 |

- 登入的計數（#5）：照 #5 的驗收條件「第 11 次錯誤登入被擋」，只計失敗的登入，成功的登入把它用掉的兩個名額還回去；帳號名稱以儲存的形式計算（去掉前後空白、轉小寫）。這是對上表「最多 10 次」的解讀，數字不變，等 owner 確認。
- IP 取自 nginx 設定的 `X-Forwarded-For`；Fastify 只信任來自 nginx 的這一跳（補充）。做法是把 nginx 的位址交給 `trustProxy`（環境變數 `TRUSTED_PROXIES`，預設 `loopback`）：Fastify 5 對數字的 `trustProxy`（「信任 1 跳」）一律不信任，因為只看跳數無法確認直接連進來的是 nginx。server 跑在容器裡時，nginx 連進來的位址不是 loopback，部署時要把 `TRUSTED_PROXIES` 設成它的位址，否則所有人都會被當成同一個 IP。

## 5. 大小上限

1 MB 是 1,048,576 bytes。

| 對象 | 上限 | 來源 |
|---|---|---|
| WebSocket 單則訊息 | 8 MB。2 MB 不夠：還原版本是客戶端送出整份內容的一筆交易，100 × 5 約 501 KB，約 125 bytes／拍點 | 設計決定 |
| 匯入的 `ScoreJSON`（`POST /api/scores/import`） | 5 MB；請求的 body 上限 5 MB 加 64 KB | 設計決定；body 的餘量是補充 |
| 樂句的 fragment（`POST`、`PUT /api/phrases*`） | 1 MB，超過回 413；請求的 body 上限 1 MB 加 64 KB | 設計決定；body 的餘量是補充 |
| 辨識的圖片（`POST /api/recognitions`） | 每張 10 MB、合計 40 MB、最多 15 張、每張最多 40 百萬像素 | 補充：沿用前身 `app/config.py` 的預設值 |
| 其他 JSON 請求 | 64 KB | 補充 |

- body 上限的做法沿用前身 `app/security.py` 的 `BodySizeLimitMiddleware`：先看 `Content-Length`，再在讀取時累計，不先整個讀進記憶體。超過時回 413 `payload_too_large`。

## 6. 回應標頭

所有回應（沿用前身 `app/security.py` 的 `SecurityHeadersMiddleware`）：

| 標頭 | 值 |
|---|---|
| `Content-Security-Policy` | 見第 7 節 |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`（只在設定啟用 HSTS 時） |
| `X-Robots-Tag` | `noindex`（補充：全站都帶；平台不對外公開） |

`Cache-Control`（沿用前身的規則）：`/api/*` 與 `/healthz` 是 `no-store`；`/assets/*`（檔名帶內容雜湊）是 `public, max-age=31536000, immutable`；其他（頁面本身）是 `no-cache`。

`Permissions-Policy` 的 `camera=()` 管的是頁面自己使用相機（`getUserMedia`）。手機上傳圖片用的 `<input type="file">` 叫出的是系統的相機或相簿，不必放寬這個標頭（[`phrases.md`](phrases.md) 第 4 節）；實機結果是人工判定項目（[`testing.md`](testing.md) 第 6 節第 4 項）。

`/s/` 與 `/api/s/`：無論如何都帶 `Referrer-Policy: no-referrer` 與 `X-Robots-Tag: noindex`（設計決定；上面的全站設定已經涵蓋，但這兩個路徑必須有，不得因為日後放寬全站設定而失去）。

## 7. CSP

沿用前身 `app/security.py:14-19` 的字串，包含 alphaTab 需要的 `worker-src 'self' blob:`：

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;
media-src 'self' blob:;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

（實際送出時是一行，各段之間以 `; ` 分隔。）

- 行內樣式允許，因為 UI 元件與 alphaTab 會在執行時設定樣式；script 維持嚴格，這才是擋 XSS 的地方。
- `connect-src 'self'` 也涵蓋同一個 host 的 `wss:`（CSP Level 3）。**補充**：e2e 監聽 `securitypolicyviolation` 事件並斷言為 0；三種瀏覽器都要過，任何瀏覽器擋了 WebSocket，就把 `wss://<公開 host>` 明確加進 `connect-src`。

## 8. 404 規則

| 情況 | 回應 |
|---|---|
| 非成員存取 `/api/scores/:id` 底下的任何 API | 404，和團譜不存在時相同 |
| 非成員打開 `/scores/:id` | SPA 顯示 404 頁（API 回 404） |
| 已刪除的團譜 | 所有人 404；只有 Owner 的「已刪除」列表與還原 API 看得到 |
| `/s/:token`、`/api/s/:token` 的 token 錯誤、已撤銷，或團譜已刪除 | 404 |
| 非 admin 存取 `/api/admin/*`（補充） | 404 |
| 別人的樂句、別人的辨識、別人的辨識原圖（補充） | 404 |

## 9. Log 與部署

- token 不得進 log：Fastify 的 request log 遮掉 query 的 `token` 參數，以及 `/s/` 與 `/api/s/` 後面的路徑段（補充）。
- nginx 範例設定：WebSocket upgrade（`/collab`）；`/auth/karyl` 關掉 `access_log`，否則 token 會留在 log 裡。**補充**：`/s/` 與 `/api/s/` 也關掉 `access_log`。
- 部署：agent 只產出 Docker Compose（server、postgres、redis、recognizer）、nginx 範例與 `docs/DEPLOYMENT.md`。實際部署是人工步驟；agent 不部署，也不改任何正式環境的設定。
- 辨識服務只在 Compose 的內部網路上，不對外開 port（補充，[`recognizer.md`](recognizer.md)）。
