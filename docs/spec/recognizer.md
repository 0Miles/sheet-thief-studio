# 辨識服務

把前身 Sheet Thief 的 Python 辨識核心複製成內部服務 `services/recognizer`，透過內部 HTTP 呼叫、回傳 JSON。設計理由見 ADR 0006。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 範圍

- 輸入只收**圖片**：PNG、JPEG、WebP。一次可以多張，視為同一個樂句的連續頁（前身 `sandbox.py:56-80,99-100` 的 `images` 工作）。
- 不開放 PDF 與 ASCII TAB 上傳，雖然核心內部能處理（圖片在子行程裡組成 PDF 再讀）。
- 只辨識弦樂 TAB；不辨識鼓與五線譜。
- 回報 4–7 弦。圖片讀法接受 4–7 條線的譜表（前身 `app/extract/raster_tab.py:190-191`），但舊站只開放六弦（前身 `music_settings.py` 的 `PROJECT_TUNINGS`、`recognition_errors.py`），非六弦的準確度沒有驗證過；實際品質是人工判定項目。
- 手機也可以上傳（[`phrases.md`](phrases.md) 第 4 節），辨識服務與 server 的介面都不用為此改動：
  - 前身讀圖時已經套用 EXIF 的方向（前身 `app/extract/raster_tab.py:2187-2205` 的 `ImageOps.exif_transpose`），直拍的照片會先轉正；這段在複製的 `extract/` 目錄裡。
  - HEIC 等其他格式在 server 收檔時就回 415 `unsupported_image`（第 7 節）。
  - 超過像素上限的照片（例如手機相機的 48 百萬像素模式）該頁回報 `image_too_large`（第 4 節）。
  - 真實手機照片的辨識品質與上傳結果，是人工判定項目（[`testing.md`](testing.md) 第 6 節第 4 項）。
- 前身的 #21（速度只從標題區讀取）在 Studio 不適用：樂句不帶速度。
- 前身的 #27 在副本裡實作（第 6 節），不在關鍵路徑上。
- 舊 repo 的 #21、#27 不動，舊站維持凍結。

## 2. 從前身複製什麼

來源：凍結 repo 的 `main`（`fd60ff6`）。不含未合併的分支 `hiad-20261020/21-heading-tempo-tuning`。

| 複製 | 不複製 |
|---|---|
| `converter`、`model`、`rhythm`、`extract/`（整個目錄）、`tunings`、`repeats`、`music_settings`、`sandbox`、`i18n`、`ocr`、`recognition_errors` | `api`、`db`、`jobs`、`storage`、`gp5_writer`、`gp_edit`、`musicxml`、`preview` |

- converter 會 import `gp5_writer` 與 `preview`（前身 `app/converter.py:19,28`），副本要切掉這兩個依賴。**補充**：converter 用到的常數（`MAX_STRINGS`、`MAX_TRACKS`）搬進副本自己的模組；寫 GP5 與產生預覽的程式碼刪掉。
- **補充**：`sandbox.py` 需要的設定（第 4 節的限制）放進副本自己的設定模組，用環境變數覆寫；不複製前身 `config.py` 裡資料庫、session 等無關的設定。
- 測試：pytest，加上從舊 repo 複製的 fixture 圖片（`tests/fixtures/*.png` 與它的 `README.md`）。這些圖片是合成的 smoke 圖，README 自己寫明不是準確度基準。
- **補充**：Python 3.12（前身 `Dockerfile` 的 `python:3.12-slim-bookworm`）。依賴從前身的 requirements 檔挑出核心需要的部分；不需要 PyGuitarPro（只有 `gp5_writer` 用到）。`requirements-ocr.txt` 要用 `pip install --no-deps --ignore-requires-python -r requirements-ocr.txt` 安裝。
- 服務有自己的 `Dockerfile`，由 repo 的 Compose 建置。

### 2.1 授權聲明

- 保留 MIT 的 `LICENSE`（前身 repo 根目錄的那一份，原樣複製到 `services/recognizer/LICENSE`）。
- `services/recognizer/THIRD_PARTY_NOTICES.md`（補充：檔名）寫明：
  - 這個目錄複製自 Sheet Thief（`0Miles/sheet-thief`）commit `fd60ff6`；
  - Sheet Thief 衍生自 [F100Pilot/PDF-to-GP5](https://github.com/F100Pilot/PDF-to-GP5) 的 commit `01d9e799d938313ce8e4f6320fc6f16b1ee8adfd`，以 MIT 授權，授權條款保留在 `LICENSE`（前身 `THIRD_PARTY_NOTICES.md:3-5`）。

## 3. HTTP 介面（內部）

服務只在 Compose 的內部網路上，不對外開 port（補充）。

| 方法與路徑 | 說明 |
|---|---|
| `POST /recognize` | `multipart/form-data`，欄位 `images` 依頁序重複出現。成功 200，回傳第 5 節的結果；辨識失敗 422，回傳錯誤；忙碌 503，回傳 code 是 `busy` 的錯誤（第 5.2 節；補充，#59）；請求本身不合（沒有圖片、格式不對）400 |
| `GET /healthz` | 200 |

- 同步呼叫：一次只跑一件；正在跑的時候，新的請求立刻回 503，對應舊的 `busy` code。
- **補充**：埠號 8000；Node 端呼叫的逾時是 930 秒（整體上限 900 秒加 30 秒餘裕）。

## 4. 限制與逾時

保留 `sandbox.py` 的子行程隔離與限制（前身 `app/config.py`）：

| 限制 | 值 |
|---|---|
| 沒有進度的逾時（讀一頁） | 120 秒 |
| 整體逾時 | 900 秒 |
| 每個子行程的記憶體 | 3072 MB |
| 同時執行 | 1 件 |
| 每張圖片的像素 | 補充：40 百萬像素（前身 `max_image_megapixels`），超過時該頁回報 `image_too_large` |
| 圖片張數 | 補充：最多 15 張（前身 `max_image_pages`） |
| 每張大小、合計大小 | 補充：10 MB、40 MB（前身 `max_upload_mb`、`max_total_upload_mb`）；server 在收檔時就先擋（[`security.md`](security.md)） |

## 5. 契約

辨識服務回傳**它自己的中間模型 JSON**，帶版本號，以 JSON Schema 描述；Python 核心不認得 Studio 的 schema。

- 新增的 JSON 出口放在 `_build_track` 之後、`_unify_bars` 之前（前身 `converter.py:558,738`）。理由：`_unify_bars` 會切掉超出拍號的音（前身 `converter.py:738-745`），違反 Studio「只標記、不改寫」的原則。
- JSON Schema 放在 `services/recognizer/contract/recognition.schema.json`（補充：路徑），版本號從 1 開始。形狀改了就升版本號。
- Python 與 TypeScript 兩邊用同一批契約 fixture 測試（補充：放在 `services/recognizer/contract/fixtures/`，TypeScript 的測試直接讀這個目錄）。
- **補充**（#59）：server 讀這份 JSON 用的 zod 形狀在 `packages/contracts/src/recognizer.ts`（`recognizerResponse`、`recognizerResult`、`recognizerFailure`）。`packages/contracts/tests/recognizer.test.ts` 用 Ajv（JSON Schema 2020-12）與 zod 驗證每一份 fixture，也驗證故意改壞的版本兩者都拒絕，並檢查 schema 的每個欄位都有 `description`。欄位的意思寫在 schema 的 `description` 裡；本節只寫大綱與跨欄位的規則。
- **補充**：fixture 至少包含六弦、四弦、七弦、帶 capo、讀不懂的調弦、帶裝飾音與刷弦（含力度）的結果各一份，以及 `recognition_failed`（四種頁層級原因）、`timeout`、`busy`、`unavailable` 的錯誤各一份。改契約時，這些 fixture 跟著改。
- 只傳穩定的 code 加參數；自由文字只寫進 log。理由：舊核心的訊息是葡文、英文（前身 `i18n.py:20` 預設是 `"pt"`），而 Studio 介面只有繁中。

### 5.1 成功的結果（大綱）

欄位以前身 `app/model.py` 的 `Score`、`ScoreMeasure`、`ScoreBeat`、`ScoreNote` 為準，改成 camelCase。只輸出已經解析完的欄位（`parenthesized`、`tieArc`、`link` 這類「還沒解析」的欄位在出口之前就要解析掉，做法照舊管線在 `_build_track` 之內做的事）。

**補充**（#59）：出口只拿 `_build_track` 的結果，不跑 `convert_many` 在它之後做的事，包括 `_align_by_numbers`（照印出的小節號碼補休止小節）：只標記、不改寫。所以不輸出 `ScoreMeasure.number`，也不輸出 `Score` 的 `name`、`instrument`、`muted`（樂句不帶這些）。

```json
{
  "contract": "sheet-thief-studio/recognition",
  "version": 1,
  "strings": 6,
  "tuning": { "midi": [64, 59, 55, 50, 45, 40], "source": "detected", "reason": null, "raw": null },
  "capo": { "fret": 0, "source": "detected" },
  "timeSignature": { "numerator": 4, "denominator": 4 },
  "bars": [
    {
      "timeSignature": null,
      "marker": null, "tempo": null, "repeatOpen": false, "repeatTimes": 0, "endings": [],
      "sign": null, "jump": null, "rhythmEstimated": false,
      "beats": [
        {
          "units": 8, "tuplet": false,
          "notes": [
            {
              "string": 1, "fret": 3, "dead": false, "ghost": false, "tie": false, "vibrato": false,
              "hammer": false, "slide": false, "slideShift": false, "slideIn": null, "slideOut": null,
              "harmonic": null, "tapped": false, "graceFret": null, "graceHammer": false, "staccato": false,
              "bendSemitones": 0, "bendRelease": false, "bendPre": false, "letRing": false, "palmMute": false,
              "stroke": null, "velocity": null
            }
          ]
        }
      ]
    }
  ],
  "warnings": []
}
```

- `strings`：4–7。`tuning.midi`：第 1 弦（最高）在前。
- `tuning.source`：`"detected"`（譜面或標題區印的調弦）或 `"default"`（該弦數的標準調弦）；`reason` 是讀不到時的原因代碼（例如 `"unrecognized"`）；`raw` 是讀不懂時保留的原文（前身 `tunings.py` 的 `TuningChoice`）。
- `capo.source`：`"detected"` 或 `"default"`。
- 每個小節的 `timeSignature` 是 `null` 時沿用前一個。
- `units` 是寫出來的長度，以 32 分音符為單位，一定能表示成一個音符加 0–2 個附點：1、2、3、4、6、7、8、12、14、16、24、28、32、48（第 7.2 節的表）；`tuplet` 為真表示三連音。
- **補充**（#59）JSON Schema 與 zod 都檢查的規則（`packages/contracts/tests/recognizer.test.ts` 裡每一條都有改壞的版本）：
  - `tuning.midi` 的個數等於 `strings`；音符的 `string` 不超過 `strings`；同一個拍點上每條弦最多一個音符。
  - `fret` 只有 `dead` 時是 `null`；`graceHammer` 只有 `graceFret` 不是 `null` 時才可能為真。
  - `tuning`：`source: "detected"` 時 `reason`、`raw` 都是 `null`；`source: "default"` 時 `reason` 是 `"not_found"`（`raw` 是 `null`）或 `"unrecognized"`（`raw` 是讀不懂的原文）。辨識服務不接受指定調弦，所以沒有前身的 `"manual"` 與 `"string_count_mismatch"`。
  - `capo`：`source: "default"` 時 `fret` 一定是 0。
  - 拍號：整首的 `timeSignature` 在前身 `music_settings` 的範圍內（分子 1–16，分母 2、4、8、16；前身讀到範圍外的值時用 4/4）；小節的 `timeSignature` 可以到前身讀譜面拍號的範圍（分子 1–32，分母 1、2、4、8、16、32），和 `schema.md` 的拍號範圍相同。
  - 小節的 `sign`、`jump` 只收小寫的 code（`segno`、`coda`、`fine`；`da_capo`、`da_capo_al_coda`、`da_capo_al_fine`、`da_segno`、`da_segno_al_coda`、`da_segno_al_fine`、`to_coda`）。
  - `endings`、`rhythm_estimated` 的 `bars` 裡同一個數字最多出現一次（不檢查順序）。
  - 所有物件都不接受多出來的欄位；多了欄位就是另一個版本。
- **補充**（#59）其他約定（不是驗證規則）：
  - 拍點的時值總和可以和拍號不合：超出或不足的小節照樣輸出（只標記、不改寫）。
  - `sign`、`jump` 不用前身 Guitar Pro 的名稱；前身的 `"Da Coda"` 就是 `to_coda`。
  - 前身管線會產出、契約不收的值，由出口（#61）先處理：悶音的格號 0 寫成 `null`；跳房子讀到的 0（前身 `bar_signs.py` 的 `\d` 也吃得到 `0.`）不輸出。
- `warnings` 只有 code 與參數，也包含辨識時略過的項目。**補充**：舊核心給人看的警告句子，在副本裡逐一改成 code；還沒有對應 code 的，回報 `{ "code": "other", "params": {} }`，原文寫進 log。

**補充**（#59）：版本 1 的 `warnings` code（前身產生這些句子的位置在括號裡）：

| code | `params` | 意思 |
|---|---|---|
| `rhythm_estimated` | `{ bars }` | 這些小節（從 1 數起）的時值是從音符的間距估出來的，而同一個聲部的其他小節讀到了印出的節奏；和小節的 `rhythmEstimated` 一致。出口（#61）從 `_build_track` 的小節與 `report["rhythm_from_notation"]` 重新算，只在讀到印出的節奏（有不是 tie 的音、沒有估時值的小節）時才發；不沿用前身的 `_flag_estimated_rhythm`，因為它跑在 `_align_by_numbers`、`_unify_bars`、`_expand_repeats` 之後，小節號碼已經變了 |
| `overlapping_notes` | `{ page, count }` | 那一頁同一條弦上重疊的音符，略過了幾個（前身 `rhythm.py:81`） |
| `staves_ignored` | `{ count }` | 弦數和多數不同的譜表，略過了幾行（前身 `converter.py` 的 `_main_staves`） |
| `bar_too_dense` | `{ page, notes }` | 那一頁有個小節讀到的音多到超出拍號，這個小節的音都當成 32 分音符（前身 `rhythm.py:447`） |
| `fixed_durations` | `{}` | 不是每一行都有小節線，時值用固定長度（前身 `rhythm.py:543`） |
| `other` | `{}` | 還沒有對應 code 的提醒 |

- 調弦讀不到或讀不懂的提醒不另外回報：`tuning.reason` 已經說了。前身每讀一張圖片就加的「從圖片讀出的 TAB，請檢查」提醒也不回報：Studio 的辨識一定是圖片。
- 要加新的 code，就是改了形狀：升版本號。

### 5.2 失敗的結果

```json
{
  "contract": "sheet-thief-studio/recognition",
  "version": 1,
  "error": { "code": "recognition_failed", "params": {}, "pages": [{ "page": 2, "code": "no_notes" }] }
}
```

| code | 層級 | 意思 |
|---|---|---|
| `no_staff` | 頁 | 找不到譜表的線 |
| `no_notes` | 頁 | 找到線，但讀不到格號 |
| `invalid_image` | 頁 | 圖片無法解碼或檔案損壞 |
| `image_too_large` | 頁 | 圖片超過像素上限 |
| `recognition_failed` | 整件 | 其他辨識失敗；有頁層級的原因時列在 `pages` |
| `timeout` | 整件 | 超過 120 秒沒有進度，或整體超過 900 秒 |
| `unavailable` | 整件 | 補充：子行程無法啟動（前身 `ConversionUnavailable`） |
| `busy` | 整件 | 已經有一件在跑（HTTP 503） |

- **補充**（#59）：`params` 在版本 1 一律是 `{}`；`pages` 只有 `recognition_failed` 會有，其他 code 是空陣列。`busy` 的 503 回應也是這個形狀。

Studio 的 server 另外用 `interrupted`：server 重新啟動時，殘留的「執行中」辨識標成失敗（第 7 節）。介面依 code 顯示 `strings.ts` 裡的繁中文字與建議。

## 6. #27：調弦名稱後面接說明

照前身 #27 的 triage 留言（Agent Brief）裡的維護者決定與驗收條件，在副本裡實作。驗收條件的完整清單見 `gh issue view 27 --repo 0Miles/sheet-thief --comments`；下面是規則與測試案例。#27 裡「寫進 `docs/API.md`」與「中英兩份 CHANGELOG」兩項在 Studio 改成：規則寫在本節，案例寫成 pytest。

### 6.1 規則

1. 只有帶標籤的 `Tuning:`、`Tuning -` 行才適用「名稱＋說明」；只寫 `Tuning` 的句子不算。
2. 名稱後面必須接分隔符號：`(`、`[`、`-`、`–`、`—`、`,`、`;`、`:`、`/`。名稱直接接字母時不算符合，所以 `Standardized`、`Standard tuning` 都不算。
3. 說明拆成各部分，每一部分都必須屬於下列四類白名單之一，可以組合：
   - **音名**：大寫的音名 token，可帶 `#`、`b`、`♯`、`♭`；或連寫成一串，例如 `EADGBE`。小寫或其他寫法都不算音名。
   - **capo**：`capo N`、`No capo`。
   - **調性**：例如 `Key: D`、`key of E minor`。
   - **標準音高**：例如 `A = 440`、`A = 432 Hz`。
4. 任何一部分不屬於白名單，整行回報 `unrecognized`，並保留原文（`tuning.raw`）。
5. 音名沒有標方向時，正讀或反讀只要有一個方向和名稱的調弦一致，就照名稱讀。例如 `Standard (E B G D A E)` → standard。
6. 音名和名稱不一致時，以音名為準，弦數也照音名。例如 `Standard (D A D G B E)` → D A D G B E；`Standard (E A D G)` → 四弦。
   - 有 `low to high`、`high to low` 標籤時照標籤讀。
   - 沒有標籤時，照「純音名」的既有慣例，由低音弦寫起。
7. `Tuning: Standard - No capo` 同時得到 standard 與 capo detected 0（capo 的讀取規則不變）。
8. 讀取調弦行的判讀，回傳「(調弦音名, 讀不懂的原文)」的語意不變；報告的 `source`、`reason`、`raw` 照舊。
9. 讀不懂時用標準調弦；審核頁顯示警告，並可以手動選調弦（[`phrases.md`](phrases.md) 第 7 節）。

### 6.2 測試案例（照 #27 的驗收條件）

讀成名稱所指的調弦：

- `Standard (E A D G B E)`、`Standard - E A D G B E`、`Standard - EADGBE`、`Standard [E A D G B E]`
- `Standard (low to high: E A D G B E)`、`Standard (high to low: E B G D A E)`、`Standard (E B G D A E)`
- `Drop D: D A D G B E`、`Drop D (D A D G B E)`、`Half step down - Eb Ab Db Gb Bb Eb`
- `Standard - No capo`、`Standard - capo 2`、`Standard (E A D G B E) - capo 2`
- `Drop D - Key: D`、`Standard (key of E minor)`、`Standard (A = 440)`、`Standard (A = 432 Hz)`

以音名為準：`Standard (D A D G B E)` → D A D G B E；`Standard (E A D G)` → 四弦 E A D G。

回報 `unrecognized` 並保留原文：

- `Standard (Eb)`、`Standard, down 1/2 step`、`Standard - drop d`、`Standard - 1/2 below`、`Standard - lowered 1/2`
- `Standard - DADGAD on the intro`、`Drop D - drop c on song 2`、`Standard - Nashville tuning`
- `Drop D (D A D G B E) down a whole step`、`Standard (E A D G B E) half step down`
- `Standard tuning`、`Standardized`

另外：`Tuning: Standard - No capo` 同時得到 capo detected 0；既有的調弦與 metadata 測試全部通過。

範圍外（照 #27）：速度只讀標題區（#21）；調弦的讀取範圍（仍讀第 1 頁的 Tuning 行）；音名在前、名稱在後的寫法（`D A D G B E (Drop D)`）；同一行出現多個調弦時的 alternatives。

## 7. Server 這一側

- 同步呼叫辨識服務的內部 HTTP，不搬 arq 佇列。
- `POST /api/recognitions`（[`routes.md`](routes.md)）：
  1. 檢查圖片的格式（以檔頭判斷 PNG、JPEG、WebP，補充）、張數與大小。
  2. 這個帳號已經有一件在跑：409 `recognition_in_progress`。**補充**：伺服器上已經有任何一件在跑（只有一個 server 行程，它自己知道）：503 `recognizer_busy`，不建立紀錄。
  3. 建立 `recognitions` 的一列（狀態「執行中」），原圖存進去，回 202 `{ id }`。
  4. 在背景呼叫 `POST /recognize`（不在瀏覽器的請求裡等），完成時更新狀態。辨識服務仍然回 503 時，標成失敗、code `busy`。
- 瀏覽器輪詢 `GET /api/recognitions/:id`（補充：每 2 秒）。
- 每個帳號同時最多一件；server 啟動時，把殘留的「執行中」標成失敗（code `interrupted`）。
- 原圖以 `bytea` 存在 Postgres，跟著那筆辨識：存成樂句或捨棄時刪除，最多保留 7 天。**補充**：用子表 `recognition_images`（`recognition_id`、`page`、`mime`、`data bytea`，`ON DELETE CASCADE`），因為不確定 Sequelize 對 `bytea[]` 的支援；生命週期和「存在那一列」相同。超過 7 天的辨識整筆刪除，由每小時一次的定時工作處理（和刪除團譜的定時工作同一個）。
- 只有發起辨識的帳號可以讀原圖與結果；其他人一律 404。
- **補充**（#63）實作的細節：
  - 辨識服務的網址是環境變數 `RECOGNIZER_URL`（開發時預設 `http://127.0.0.1:8000`，正式環境必填）。Node 端用 `node:http` 呼叫，不用 `fetch`：`fetch` 等回應標頭最多 300 秒，辨識可能跑到 900 秒。回應最多讀 32 MB（`limits.ts` 的 `RECOGNIZER_ANSWER_LIMIT`）。
  - 上傳的 `multipart/form-data` 用 Node 內建的 `Response.formData()` 解析（lockfile 裡沒有 `@fastify/multipart`），只在 `POST /api/recognitions` 的封裝範圍裡註冊；body 上限是 40 MB 加 64 KB（`RECOGNITION_BODY_LIMIT`），照 Fastify 的做法先看 `Content-Length` 再累計。
  - 「伺服器上已經有一件在跑」指辨識服務還沒回答：服務一回答就讓出，不等結果寫進資料庫，所以看到上一件結束的人馬上可以再送一件。每個帳號最多一件由資料庫的部分唯一索引（`status = 'running'`）保證，兩個同時的請求只會建立一筆。
  - 失敗的 code：辨識服務回 503 → `busy`；回 422 → 它的 `error`；連不上、回其他狀態、或回答不符合契約 → `unavailable`（細節只進 log）；Node 端 930 秒沒有回答 → `timeout`；回答符合契約但轉出的片段過不了樂句的 zod（例如超過 1 MB）→ `recognition_failed`；server 關閉時正在跑的那件 → `interrupted`（和重新啟動時殘留的一樣）。
  - 捨棄一件還在跑的辨識：那一列與原圖立刻刪除，辨識服務的回答到了也不寫回。
  - 原圖的回應帶 `Cache-Control: private, no-store`：存成樂句或捨棄後就不存在，瀏覽器與中間的快取都不留。
  - 測試與 e2e 用的假辨識服務在 `apps/server/tests/fakeRecognizer.ts`：同樣的 HTTP 介面，預設回契約 fixture；e2e 用 `pnpm --filter @studio/server recognizer:e2e` 啟動（`PORT` 預設 8000、`FIXTURE` 預設 `six-strings`）。

### 7.1 `recognitions` 表（補充：欄位草案）

| 欄位 | 說明 |
|---|---|
| `id`、`account_id` | |
| `status` | `'running'`、`'succeeded'`、`'failed'` |
| `page_count` | 補充（#63）：原圖的張數，列表與審核頁不必讀子表 |
| `error` | `jsonb`：`{ code, params, pages }`，失敗時才有 |
| `fragment` | `jsonb`：轉換並以 zod 驗證過的 `PhraseFragment`（小節段） |
| `report` | `jsonb`：偵測到的弦數、調弦（含來源、原因、原文）、capo，以及略過的項目 |
| `created_at`、`finished_at` | |

### 7.2 轉成 `PhraseFragment`

辨識完成時，server 用 TypeScript 把中間模型轉成 fretted 的小節段，以 zod 驗證後存進那一列。

| 中間模型 | `PhraseFragment` |
|---|---|
| `strings`、`tuning.midi` | `tuning`（第 1 弦在前）；讀不懂時（補充，#63：`source: "default"` 的兩種 `reason` 都算，不用辨識服務猜的值）是該弦數的標準調弦：4 弦 `[43, 38, 33, 28]`、5 弦 `[43, 38, 33, 28, 23]`、6 弦 `[64, 59, 55, 50, 45, 40]`、7 弦 `[64, 59, 55, 50, 45, 40, 35]`（補充：4、5 弦當成貝斯） |
| 小節的 `timeSignature`（`null` 時沿用前一個；第一個用整首的） | `bars[].timeSig` |
| `beats` | `voices["0:0"]` |
| `units` | `value` 與 `dots`：1 → 32、2 → 16、3 → 16 加 1 個附點、4 → 8、6 → 8 加 1、7 → 8 加 2、8 → 4、12 → 4 加 1、14 → 4 加 2、16 → 2、24 → 2 加 1、28 → 2 加 2、32 → 1、48 → 1 加 1（補充：契約只接受這些值） |
| `tuplet: true` | `tuplet: { actual: 3, normal: 2 }` |
| `string`、`fret` | 音符鍵 `s<string>`、`fret`；`dead` 時不寫 `fret` |
| `dead`、`ghost`、`tie`、`vibrato`、`staccato`、`letRing`、`palmMute` | 同名欄位（`true` 才寫） |
| `tapped` | `tap` |
| `harmonic` | `harmonic`（`natural`、`pinch`、`artificial`） |
| `hammer` | `legato` |
| `slide` | `slideOut: "legato"` |
| `slideShift` | `slideOut: "shift"` |
| `slideOut: "up"`、`"down"` | `slideOut: "outUp"`、`"outDown"`（補充：同時有 `slide`／`slideShift` 時，以後兩者為準；`slide` 與 `slideShift` 同時為真時是 `shift`，#63） |
| `slideIn: "below"`、`"above"` | `slideIn: "inBelow"`、`"inAbove"` |
| `bendSemitones`、`bendRelease`、`bendPre` | `bend`：`bendSemitones` 是 0 就沒有；`bendPre` 加 `bendRelease` → `preBendRelease`，只有 `bendPre` → `preBend`，只有 `bendRelease` → `bendRelease`，都沒有 → `bend`。`semitones` 夾在 1–4，超過 4 時記一筆略過項目（補充） |
| `graceFret`、`graceHammer` | 丟掉；數量列在略過項目裡（前身 `model.py:51-53`） |
| 音符的 `stroke` | 聚合成拍點的 `stroke`（`down`、`up`） |
| 音符的 `velocity` | 聚合成拍點的 `dynamic` |

- 聚合（前身 `app/model.py:45-46,127-129`）：**補充**：取拍點上最多音符共有的值；平手時取弦號最小的那個音的值；全部是 `null` 就不寫。**補充**（#63）：`null` 的音不算票，有一個音有值就取那個值；力度先把每個音的 velocity 換成力度再聚合。
- **補充**（#63）：`dynamic` 是「從這個拍點起」（[`schema.md`](schema.md) 第 8 節的 #30 補充），所以只在聚合出的力度和當時生效的不同時才寫（跨小節也延續）；每個拍點都寫的話，每個拍點都會畫一個力度記號。
- velocity → dynamic（補充，依前身 `app/extract/annotations.py:35` 的對照取最接近的）：≤ 39 → `pp`（含 ppp），40–55 → `p`，56–71 → `mp`，72–87 → `mf`，88–103 → `f`，≥ 104 → `ff`（含 fff）。
- 小節層級的 `marker`、`tempo`、`repeatOpen`、`repeatTimes`、`endings`、`sign`、`jump` 不放進片段（樂句不帶這些），各自列在略過項目裡（補充）。
- 略過項目（`report.skipped`，補充）：`{ code: "grace_notes", count }`、`{ code: "capo", fret }`（capo 不是 0 時）、`{ code: "tuning_unrecognized", raw }`、`{ code: "bend_clamped", count }`、`{ code: "sections" }`、`{ code: "tempo" }`、`{ code: "repeats" }`、`{ code: "jumps" }`。審核頁依 code 顯示。
- 超出拍號的小節照樣放進片段，由 Flag 標出（不截斷）。
