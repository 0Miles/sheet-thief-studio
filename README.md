# Sheet Thief Studio

樂團一起寫譜的線上平台：多聲部的團譜可以多人同時編輯，像樂譜版的 Google 文件。

M0（技術驗證）已完成，接下來是 M1a；目前還不能使用。計畫與進度見 [`docs/ROADMAP.md`](docs/ROADMAP.md)，規格見 [`docs/spec/`](docs/spec/)。

## 目標

- 團譜線上即時共編：同一份譜、同一個小節可以多人同時改，看得到彼此的游標。
- 多聲部：弦樂 TAB（吉他、貝斯）、鼓、五線譜（鍵盤、人聲）。
- 個人樂句庫：樂句可以從圖片讀取或自己打譜，共編時拖進指定小節。
- 線上播放。
- 用鍵盤即時打譜的介面。

## 結構

| 路徑 | 內容 |
|---|---|
| `apps/web` | Vue 3 網頁（Vite、pinia、vue-router、`@karyl-chan/ui`） |
| `apps/server` | Fastify API 與 Hocuspocus 共編伺服器 |
| `packages/score-model` | 團譜文件：Yjs schema、編輯指令、檢查；前後端共用 |
| `packages/score-editor` | 打譜：游標、按鍵對應到指令、復原、唯讀，以及給哪一種視圖；不碰 DOM，任何 `Y.Doc` 都能用 |
| `packages/score-render` | 譜面顯示與播放（alphaTab 只在這裡使用） |
| `packages/contracts` | API 的資料形狀（zod） |
| `docs/` | 詞彙表以外的文件：ADR、規格附錄（`docs/spec/`）、路線圖、技術驗證報告 |

詞彙見 [`CONTEXT.md`](CONTEXT.md)，設計決定見 [`docs/adr/`](docs/adr/)。

## 開發

需要 Node 22 以上、pnpm 10 與 Docker。

```bash
pnpm install
docker compose -f compose.dev.yaml up -d         # Postgres（127.0.0.1:5438）與 Redis（127.0.0.1:6388）
pnpm --filter @studio/server cli migrate         # 建立或更新資料表；每次拉下新的遷移後再跑一次
pnpm --filter @studio/server cli create-admin <帳號名稱> <顯示名稱>   # 第一個管理者，只需要做一次
pnpm --filter @studio/server dev   # http://localhost:8031
pnpm --filter @studio/web dev      # http://localhost:5183，用剛建立的管理者登入
```

- `create-admin` 的密碼不放在指令列（10–256 字元）：在終端機裡會提示輸入兩次、不顯示；不是終端機時讀標準輸入的第一行，例如 `pnpm --filter @studio/server cli create-admin miles Miles < password.txt`。Git Bash（mintty）不算終端機，輸入會顯示在畫面上，建議用 PowerShell 或 Windows Terminal。
- **開發用 cookie**：Safari（WebKit）在 http 上不收 `__Host-` cookie，手機在區網用 http 連線也一樣。這時伺服器改用不帶前綴、不帶 `Secure` 的 `studio_session`：

  ```bash
  INSECURE_COOKIES=1 pnpm --filter @studio/server dev                # bash
  $env:INSECURE_COOKIES = "1"; pnpm --filter @studio/server dev      # PowerShell
  ```

  `NODE_ENV=production` 時這個設定無效，一律是 `__Host-studio_session`。

- **區網實機測試**（手機連開發機）：會改動東西的請求要帶和 `PUBLIC_ORIGIN` 相同的 `Origin`，所以 server 要知道手機用的網址，Vite 也要對區網開放：

  ```bash
  INSECURE_COOKIES=1 PUBLIC_ORIGIN=http://<區網 IP>:5183 pnpm --filter @studio/server dev
  pnpm --filter @studio/web dev --host
  ```

伺服器讀的環境變數（開發時都有預設值，正式環境的前三個必須設定）：

| 變數 | 開發時的預設 | 說明 |
|---|---|---|
| `DATABASE_URL` | `postgres://studio:studio@localhost:5438/studio` | Postgres |
| `REDIS_URL` | `redis://localhost:6388/0` | Redis：session 與速率限制 |
| `PUBLIC_ORIGIN` | `http://localhost:5183` | 網頁的 origin；會改動東西的 API 請求要帶這個 `Origin` |
| `INSECURE_COOKIES` | 不設 | `1`：開發用 cookie（見上） |
| `TRUSTED_PROXIES` | `loopback` | 前面那台 nginx 的位址，從它的 `X-Forwarded-For` 取得使用者的 IP |
| `HOST`、`PORT` | `127.0.0.1`、`8031` | |
| `WEB_ROOT` | 不設 | 網頁 build 的目錄（`apps/web/dist`）：設了之後由 server 提供網頁，正式環境這樣用；開發時由 Vite 提供 |
| `HSTS` | 不設 | `1`：回應帶 `Strict-Transport-Security`（網站走 https 時才開） |

送 pull request 前（伺服器的測試要 `compose.dev.yaml` 開著，用獨立的 `studio_test` 資料庫）：

```bash
pnpm lint && pnpm typecheck && pnpm test
```

端對端測試（第一次要先 `pnpm --filter @studio/web exec playwright install chromium`）。它自己啟動 server 與網頁，用 `compose.dev.yaml` 裡獨立的 `studio_e2e` 資料庫，每次重建；先停掉開發中的 server（port 8031、5183，以及由 server 自己提供網頁的那個測試用的 8032 都要空著）：

```bash
pnpm --filter @studio/web test:e2e
```

量測（不是 CI 的關卡，見 [`docs/spec/testing.md`](docs/spec/testing.md) 第 4 節）：和端對端測試一樣自己啟動 server 與網頁（網頁用 `VITE_MEASURE=1` 建置），在編輯視圖上量，數字與截圖寫到 `docs/measurements/`。前面加 `HEADED=1` 是開視窗跑，加 `MEASURE_RUNS=3` 是只確認套件能跑：

```bash
pnpm --filter @studio/web measure
```

M0 技術驗證的結果見 [`docs/spike-report.md`](docs/spike-report.md)。
