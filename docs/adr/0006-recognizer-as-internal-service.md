# 辨識核心複製成內部服務，回傳它自己的中間模型 JSON

圖片辨識沿用前身 Sheet Thief 的 Python 核心（MIT，衍生自 F100Pilot/PDF-to-GP5）。我們把凍結 repo `main`（`fd60ff6`）的核心模組**複製**到 `services/recognizer`，保留 `LICENSE` 與衍生聲明，主平台透過內部 HTTP 呼叫它、拿回 JSON。舊站維持凍結，不改。

- **契約是辨識服務自己的中間模型 JSON**，帶版本號，以 JSON Schema 描述。Python 核心不認得 Studio 的 schema；轉成 `PhraseFragment` 由 server 用 TypeScript 做，再以 zod 驗證。Python 與 TypeScript 兩邊用同一批契約 fixture 測試。
- **出口放在 `_build_track` 之後、`_unify_bars` 之前。** `_unify_bars` 會切掉超出拍號的音（前身 `converter.py:738-745`），違反 Studio「只標記、不改寫」的原則。
- **錯誤只傳穩定的 code 與參數**（例如 `no_staff`、`no_notes`、`invalid_image`、`image_too_large`、`busy`），自由文字只寫進 log。舊核心的訊息是葡文與英文（前身 `i18n.py:20` 預設 `"pt"`），而 Studio 的介面只有繁中。
- **同步的內部 HTTP，一次只跑一件，忙碌時回 503。** 保留 `sandbox.py` 的子行程隔離與限制（沒有進度 120 秒、整體 900 秒、每個子行程 3072 MB）。不搬舊站的 arq 佇列；server 用 `recognitions` 表記錄狀態，瀏覽器輪詢。

考慮過、沒採用的做法：

- **把舊站當成外部服務呼叫。** 舊站要維持凍結，而且它只輸出 GP5 與給人看的報告。
- **用 TypeScript 重寫辨識。** 核心有大量影像與 OCR 處理，重寫的成本與風險都遠高於複製。
- **讓 Python 直接輸出 `PhraseFragment`。** Studio 的 schema 一改，Python 就要跟著改；兩種語言共用一份會變動的 schema，比共用一份穩定的中間模型難維護。
- **沿用 `convert_many` 的輸出（GP5 加報告）。** GP5 經過 `_unify_bars` 已經被截斷，而且還要再讀一次 GP5。
- **搬 arq 佇列。** 一個樂團規模的使用量，一次一件加上 503 就夠；佇列要多一個 worker 行程與重試語意。

## Consequences

- `services/recognizer` 是 repo 裡唯一的 Python；CI 在裝了 OCR 套件的 Docker image 裡跑 pytest（`requirements-ocr.txt` 要用 `--no-deps --ignore-requires-python` 安裝）。
- 前身的 #21 在 Studio 不適用（樂句不帶速度）；#27 在副本裡照它自己的驗收條件實作。舊 repo 的 issue 都不動。
- 中間模型改了形狀，就要升契約的版本號，並同時更新兩邊的 fixture 與 TypeScript 轉換。
- 細節見 `docs/spec/recognizer.md`。
