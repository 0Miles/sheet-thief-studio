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
| `packages/score-render` | 譜面顯示與播放（alphaTab 只在這裡使用） |
| `packages/contracts` | API 的資料形狀（zod） |
| `docs/` | 詞彙表以外的文件：ADR、規格附錄（`docs/spec/`）、路線圖、技術驗證報告 |

詞彙見 [`CONTEXT.md`](CONTEXT.md)，設計決定見 [`docs/adr/`](docs/adr/)。

## 開發

需要 Node 22 以上與 pnpm 10。

```bash
pnpm install
pnpm --filter @studio/server dev   # http://localhost:8031
pnpm --filter @studio/web dev      # http://localhost:5183
```

送 pull request 前：

```bash
pnpm lint && pnpm typecheck && pnpm test
```

兩個瀏覽器經伺服器共編的端對端測試（第一次要先 `pnpm --filter @studio/web exec playwright install chromium`）：

```bash
pnpm --filter @studio/web test:e2e
```

技術驗證頁：`/spike/<名稱>`（共編）與 `/local`（只在這一頁）。量測的重跑方式見 [`docs/spike-report.md`](docs/spike-report.md)。
