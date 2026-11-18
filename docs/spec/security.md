# 安全基線

Cookie、session、Origin、速率限制、密碼、大小上限、CSP、回應標頭、404 規則。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. Cookie 與 session

- Session cookie：`__Host-` 前綴，`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`，不設 `Domain`。**補充**：名稱是 `__Host-studio_session`。
- Session 存在 Redis，sliding 30 天：每次帶著有效 session 的請求，把到期時間延長成 30 天後。
- **補充**：session id 是 32 bytes 的亂數（base64url）。Redis 鍵 `session:<id>` 存 `{ accountId, createdAt, via }`；`via` 是登入方式（`'password'` 或 `'karyl-chan'`，#7），強制改密碼只看用密碼登入的 session，沒有 `via` 的舊 session 視為密碼登入；另有集合 `account-sessions:<accountId>`，用來刪除一個帳號的所有 session。
- 登入成功時換一個新的 session id（避免 session fixation，補充）。
- **Bearer**（#72）：karyl-chan bot 的代理會刪掉 cookie，所以 `/api/*` 也接受 `Authorization: Bearer <session id>`，兩個都有時用 Bearer；session 與 cookie 的是同一種。用 Bearer 的請求不會收到 `Set-Cookie`（[`karyl-login.md`](karyl-login.md) 第 5 節）。
- 停用帳號或重設密碼時，刪除該帳號所有的 Redis session，並關閉它的 `/collab` 連線（[`accounts.md`](accounts.md)）。
- **補充**（#87）：結束單一 session 時，只要已經請 Redis 刪除它，就通知關閉該 session 的 `/collab` 連線，不論 Redis 回覆成功或失敗（刪除可能已執行、只是回覆遺失）；唯一不通知的情況是 Redis 明確回答沒有這個 session。回覆遺失時不知道帳號，通知只帶 session id；錯誤照樣丟給呼叫端。
- **開發與測試環境的例外**：走 http 的開發與測試環境（`http://localhost`、區網的實機測試）可以用環境變數改用不帶前綴、不帶 `Secure` 的 cookie 名稱，做法同前身 `app/config.py` 的 `cookie_secure`。**補充**：環境變數是 `INSECURE_COOKIES=1`；名稱是 `studio_session`。
  - WebKit（Safari）在 http 上不接受 `__Host-` cookie，所以 CI 的 WebKit 打譜 smoke、在 Mac 上用 Safari 開發，以及手機的區網實機測試都要用這個設定（owner 在 2026-11-13 裁定桌面 Safari 要能打譜）。
  - Firefox 要不要用，看 [`testing.md`](testing.md) 第 5 節確認檢查 1 的結果。
  - `NODE_ENV=production` 時這個設定不生效；正式環境一律用 `__Host-` 名稱。

## 2. Origin 檢查

- `GET` 與 `HEAD` 以外的請求，任何路徑都檢查 `Origin`：必須等於設定的公開 origin（環境變數 `PUBLIC_ORIGIN`）。沒有 `Origin` 標頭也拒絕。拒絕時回 403 `bad_origin`。做法同前身 `app/security.py` 的 `OriginCheckMiddleware`。
- **補充**：不限於 `/api/*`，因為 router 先把路徑解碼再比對，只看原始網址開頭的話，`/%61pi/…` 會繞過檢查（#5）。
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
| 自己改密碼（`POST /api/me/password`） | 同一帳號 15 分鐘內最多 10 次（防止拿到 session 的人猜目前的密碼）。和登入一樣只計猜錯的次數；強制改密碼不檢查目前的密碼，所以不計（#7） | 補充 |
| 訪客取 ticket（`POST /api/s/:token`） | 同一 IP 每分鐘最多 30 次 | 補充 |
| 成員取 ticket（`POST /api/scores/:id/collab-ticket`） | 同一帳號每分鐘最多 60 次；每次請求都計，不論團譜、不論結果（#18） | 補充 |
| karyl-chan 登入（`GET /auth/karyl`） | 同一 IP 15 分鐘內最多 10 次；和密碼登入一樣只計失敗的（#72） | 補充 |
| 其他 API | 不另設限制：平台只對登入的成員開放，辨識另有「每個帳號同時一件」的限制 | 補充 |

- 登入的計數（#5）：照 #5 的驗收條件「第 11 次錯誤登入被擋」，只計失敗的登入，成功的登入把它用掉的兩個名額還回去；帳號名稱以儲存的形式計算（去掉前後空白、轉小寫）。這是對上表「最多 10 次」的解讀，數字不變（補充）。
- IP 取自 nginx 設定的 `X-Forwarded-For`；Fastify 只信任來自 nginx 的這一跳（補充）。做法是把 nginx 的位址交給 `trustProxy`（環境變數 `TRUSTED_PROXIES`，預設 `loopback`）：Fastify 5 對數字的 `trustProxy`（「信任 1 跳」）一律不信任，因為只看跳數無法確認直接連進來的是 nginx。server 跑在容器裡時，nginx 連進來的位址不是 loopback，部署時要把 `TRUSTED_PROXIES` 設成它的位址，否則所有人都會被當成同一個 IP。

## 5. 大小上限

1 MB 是 1,048,576 bytes。

| 對象 | 上限 | 來源 |
|---|---|---|
| WebSocket 單則訊息 | 8 MB。2 MB 不夠：還原版本是客戶端送出整份內容的一筆交易，100 × 5 約 501 KB，約 125 bytes／拍點 | 設計決定 |
| 匯入的 `ScoreJSON`（`POST /api/scores/import`） | 5 MB；請求的 body 上限 5 MB 加 64 KB | 設計決定；body 的餘量是補充 |
| 樂句的 fragment（`POST`、`PUT /api/phrases*`；`POST /api/recognitions/:id/save`，補充，#64） | 1 MB，超過回 413；請求的 body 上限 1 MB 加 64 KB | 設計決定；body 的餘量是補充 |
| 辨識的圖片（`POST /api/recognitions`） | 每張 10 MB、合計 40 MB、最多 15 張、每張最多 40 百萬像素（像素由辨識服務檢查，該頁回報 `image_too_large`）；請求的 body 上限 40 MB 加 64 KB | 補充：沿用前身 `app/config.py` 的預設值；body 的餘量是補充（#63） |
| 其他 JSON 請求 | 64 KB | 補充 |
| 文件裡 JSON 值的巢狀深度 | 64 層（score-model 的 `MAX_VALUE_DEPTH`）；`/collab` 收到含有更深的值、或解不開的更新時，關閉那條連線（[`collab.md`](collab.md) 第 9 節） | 補充（#102，使用者裁定） |

- **補充**（#18）：WebSocket 的上限交給 `ws` 的 `maxPayload`：超過的訊息不會被整則讀進記憶體，那條連線以 1009 關閉，其他連線不受影響。版本內容的上限（`MAX_VERSION_BYTES`）和它是同一個常數。server 的大小上限都定義在 `apps/server/src/limits.ts`（fragment 的 1 MB 來自 score-model 的 `MAX_FRAGMENT_BYTES`，由這裡轉出；辨識的 15 張來自 contracts 的 `recognitionLimits`，同樣由這裡轉出成 `MAX_RECOGNITION_IMAGES`，#63；每張 10 MB、合計 40 MB 也是 `recognitionLimits` 的 `imageBytes`、`imagesBytes`，網頁的提示文字從同一處取，#64）。
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
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`（只在設定啟用 HSTS 時。**補充**：環境變數 `HSTS=1`） |
| `X-Robots-Tag` | `noindex`（補充：全站都帶；平台不對外公開） |

`Cache-Control`（沿用前身的規則）：`/api/*` 與 `/healthz` 是 `no-store`；`/assets/*`（檔名帶內容雜湊）是 `public, max-age=31536000, immutable`；其他（頁面本身）是 `no-cache`。

**補充**（#18）：「所有回應」也包括 Fastify 在任何 hook 之前就回的：網址無法解碼（400，`frameworkErrors`）與 Node 解析不了的請求（標頭過大 431、不是 HTTP 400、逾時 408，`clientErrorHandler` 直接寫在 socket 上）。這些都帶上表的標頭與 `no-store`，body 是 `{ code: "invalid_request" }`。

**補充**（#18）：正式環境的網頁由 server 提供。環境變數 `WEB_ROOT` 指向 web 的 build 目錄（`apps/web/dist`）；沒設就不提供網頁（開發時由 Vite 提供）。

- build 裡有的檔案照原樣送出，其他 `GET` 回 `index.html`。例外回 404：`/api`、`/collab` 底下的路徑；`/assets/` 底下不存在的檔案；最後一段帶副檔名而不存在的路徑（`/favicon.ico`、`/soundfont/x.sf2`），因為頁面的路由都不長那樣。
- 路徑先 `realpath`，結果必須在 build 目錄（同樣 `realpath` 過）裡面；build 裡指向外面的 symlink 或 junction 不會送出外面的檔案。
- 只有實際送出的 `/assets/*` 檔案帶 `immutable`。每個檔案（含 `index.html`）帶以大小與修改時間做的弱 `ETag`；`If-None-Match` 相符時回 304（照樣帶安全標頭），所以 `no-cache` 的字型與音色不會每次重抓。

`Permissions-Policy` 的 `camera=()` 管的是頁面自己使用相機（`getUserMedia`）。手機上傳圖片用的 `<input type="file">` 叫出的是系統的相機或相簿，不必放寬這個標頭（[`phrases.md`](phrases.md) 第 4 節）；實機結果是人工判定項目（[`testing.md`](testing.md) 第 6 節第 4 項）。

`/s/` 與 `/api/s/`：無論如何都帶 `Referrer-Policy: no-referrer` 與 `X-Robots-Tag: noindex`（設計決定；上面的全站設定已經涵蓋，但這兩個路徑必須有，不得因為日後放寬全站設定而失去）。

## 7. CSP

沿用前身 `app/security.py:14-19` 的字串，包含 alphaTab 需要的 `worker-src 'self' blob:`：

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;
media-src 'self' blob:;
object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
```

（實際送出時是一行，各段之間以 `; ` 分隔。）

- `base-uri 'self'`（#72，原本是 `'none'`）：頁面在 karyl-chan bot 的 `/plugin/<key>/` 底下送出時，靠自己的 `<base href>` 找到 script、API 與 `/collab`（[`karyl-login.md`](karyl-login.md) 第 6 節）。`<base>` 只能指向自己的 origin，注入的 `<base>` 也導不到別的網域。
- 行內樣式允許，因為 UI 元件與 alphaTab 會在執行時設定樣式；script 維持嚴格，這才是擋 XSS 的地方。
- **補充**（#18）：頁面不向別的 host 要任何東西，也不在執行時產生程式碼，所以上面的字串不必放寬：
  - 圖示打包在 `apps/web/src/icons.ts`。`@karyl-chan/ui` 用的 `@iconify/vue` 預設會向 `api.iconify.design` 取圖示，`apps/web/vite.config.ts` 把它換成 `icons.ts` 匯出的 `Icon`（包著不連線的 `@iconify/vue/offline`）。UI 或 `@karyl-chan/ui` 用到新的圖示時要加進 `icons.ts`：`apps/web/tests/icons.test.ts` 檢查原始碼裡任何 `prefix:name` 形狀的字串與 `icon` 的字串值；執行時才組出來的名稱（`:icon="…"`）測試看不到，由 `Icon` 在找不到時 `console.error`，e2e 會因此失敗。
  - zod 預設會試一次 `new Function("")` 來決定要不要編譯 parser；CSP 會擋下並回報違規。網頁的 build 把每個 `"zod"` import 都解析到 `@studio/contracts/without-eval`（`apps/web/vite.config.ts` 的 alias；它 `z.config({ jitless: true })` 之後再匯出 zod），所以不論 build 把 zod 與 schema 切到哪個 chunk，設定都在任何 schema 建立之前；server 不受影響。**補充**（#70）：原本是在 `main.ts` 最前面 import；`/` 改成按需載入 score-render 之後，build 把 score-model 與 zod 切到一個比 `main.ts` 先執行的 chunk，每一頁都觸發一次 eval 違規，所以改成 alias。
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
- nginx 範例設定：WebSocket upgrade（`/collab`）。**補充**：`/s/` 與 `/api/s/` 關掉 `access_log`。
- plugin 模式的 `/auth/karyl` 連結經過 bot 的代理，studio 管不到那一側的 log；所以連結只能用一次、2 分鐘到期（[`karyl-login.md`](karyl-login.md) 第 2 節）。bot 前面若還有 nginx，`/plugin/` 也要轉發 Upgrade。
- 部署：agent 只產出 Docker Compose（server、postgres、redis、recognizer）、nginx 範例與 `docs/DEPLOYMENT.md`。實際部署是人工步驟；agent 不部署，也不改任何正式環境的設定。
- 辨識服務只在 Compose 的內部網路上，不對外開 port（補充，[`recognizer.md`](recognizer.md)）。
