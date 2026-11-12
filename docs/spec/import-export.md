# 匯入與匯出（M5）

標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 通則

- 匯入、匯出都在瀏覽器端、在 `packages/score-render` 裡做（alphaTab 只在這裡出現，ADR 0003）。
- 匯出的品質綁在投影的完整度上：沒有投影的技巧就匯不出去。
- 第一張匯入匯出的票要做 round-trip 測試（第 4 節）。

## 2. 匯入（Import）

**Import** 是「alphaTab 模型 → `ScoreJSON`」的獨立函式，和 Projection 是兩個詞；Projection 仍然是單向的。

- 用 `ScoreLoader.loadScoreFromBytes` 讀檔（`alphaTab.d.ts:15848`）。
- 格式：GP3、GP4、GP5、GPX、GP7、MusicXML。
- 一律建立新團譜：客戶端產生 `ScoreJSON`，`POST /api/scores/import`；伺服器用 zod 驗證後，以 `jsonToDoc` 建立文件。不做匯入到既有團譜。
- 上限：聲部 16 個（非鼓聲部最多 15 個）、小節 1000 個、JSON 5 MB。**補充**：超過任何一項時不建立，顯示是哪一項超過；不自動截斷。
- 轉不過來的內容列在**匯入報告**；報告在建立前顯示，使用者確認後才建立（補充）。
- 匯入產生的 id 都是新的（`nanoid(10)`）。
- `/` 的「匯入」按鈕開檔案選擇；**補充**：檔案大小上限 20 MB（在讀檔前檢查）。

### 2.1 對照

| alphaTab 模型 | `ScoreJSON` |
|---|---|
| `score.title` | `title`（截到 100 字元，截斷時列入報告；空的時候用檔名，補充） |
| `score.artist` | `meta.artist`（截到 100 字元） |
| staff 的 `isPercussion` | `kind: "percussion"` |
| 有 `stringTuning` 的 staff | `kind: "fretted"`；`tuning` 是 `stringTuning.tunings`，第 1 弦在前；`capo` 是 `staff.capo` |
| 其他 | `kind: "pitched"` |
| `track.name` | `name`（截到 64 字元） |
| `track.playbackInfo.program` | `program` |
| pitched 的 staff 與第一小節的 clef（補充） | `staves`：G2 → `treble`，G2 加 8vb → `treble-8vb`，F4 → `bass`；其他譜號 → `treble` 並列入報告；超過 2 個譜表時只取前 2 個並列入報告 |
| `MasterBar` 的拍號 | `timeSig` |
| 小節開頭的速度 automation | `tempo`；小節中途的速度變化列入報告 |
| `Bar.keySignature`、`keySignatureType`（第一個 staff 的） | `keySig` |
| `isRepeatStart`、`repeatCount`、`alternateEndings` | `repeatStart`、`repeatEnd`、`voltas` |
| `section.text` | `section`（截到 64 字元） |
| `isAnacrusis`（只有第一小節） | `anacrusis` |
| fretted 音符 | `s<弦數 − note.string + 1>`、`fret`（超過 36 時丟掉並列入報告） |
| percussion 音符的 `percussionArticulation` | `p<id>` |
| pitched 音符 | `n<實際音高>`；`accidentalMode` 是強制升、降、重升、重降時寫入 `spell`，其他情況不寫（投影時依調號決定，[`schema.md`](schema.md) 8.1） |
| 技巧欄位 | [`schema.md`](schema.md) 第 8 節投影對照的反向；支援範圍以外的列入報告 |
| `beat.lyrics[0]` | `lyric`（截到 32 字元）；第二行以後列入報告 |
| `beat.text` | `text`（截到 64 字元） |
| `beat.dynamics` | `dynamic`：ppp → `pp`、fff → `ff`，其他照名稱（補充） |
| 聲線 | 每個譜表取前 2 條聲線；更多的列入報告 |

- **補充**：bend 轉成最接近的支援形式：依 `bendType` 對應 `bend`、`bendRelease`、`preBend`、`preBendRelease`（`Custom`、`Hold`、`Release`、`PrebendBend` 取最接近的一種並列入報告），半音數取 bend points 的最大值換算後四捨五入，夾在 1–4。
- 列入報告的「不做」項目（[`schema.md`](schema.md) 第 3、8 節）：D.S.、D.C.、Coda、Fine 等跳躍，小節中途變速或變拍，swing feel，速度文字，裝飾音、搖桿、tremolo picking、trill、自由推弦曲線、指法、漸強漸弱，flam、roll、choke，圓滑線、踏板、ottava、跨譜表連桿、和弦指法圖、斜線節奏譜，移調樂器。
- 多小節休止在 alphaTab 的模型裡本來就是一個個小節，照常匯入。

## 3. 匯出

- `projectScore` 加上 `Gp7Exporter`，或 `MidiFileGenerator`；前身 `frontend/src/score/exporters.ts:7-16` 有寫法。
- 格式：GP7、MIDI。任何成員都可以用（包含 Viewer），訪客不行（介面沒有按鈕，不是安全邊界）。
- GP7 匯出會寫入拍點上的歌詞（`alphaTab.core.mjs:77553-77558`）。
- 不做 PDF、列印、圖片匯出。
- **補充**：檔名是團譜標題加 `.gp` 或 `.mid`，把檔名不允許的字元換成 `_`；標題是空的時用「未命名」。
- **補充**：Mixer 的設定（靜音、獨奏、音量、速度）不套用到匯出；匯出的是團譜本身。MIDI 匯出不含節拍器與預備拍。

## 4. Round-trip 測試

M5 第一張匯入匯出的票必須做：

- 對 GP5、GP7、MusicXML 的樣本做「匯入 → `ScoreJSON` → 投影 → 匯出 → 再匯入」。
- 斷言支援範圍內的內容不變；不支援的內容列進匯入報告。
- 設計時沒有實際跑過 alphaTab 的匯入匯出，所以這是確認檢查（[`testing.md`](testing.md)）。
- **補充**：樣本檔不從網路下載，由這張票自己產生並放進 repo：GP7 用 alphaTab 從一份 `ScoreJSON` 匯出；MusicXML 手寫一份小的 XML；GP5 用一支小的 Python 腳本以 PyGuitarPro 寫出一次（前身 `gp5_writer` 的做法），把產生的檔案提交成 fixture，腳本與執行方式寫在樣本旁的 README。
