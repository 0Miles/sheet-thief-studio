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
| 有 `stringTuning` 而且顯示 TAB（`showTablature`）的 staff（#69 更正，見 2.2） | `kind: "fretted"`；弦數不在 4–7 時改成 pitched 並列入報告；`tuning` 是 `stringTuning.tunings`，第 1 弦在前；`capo` 是 `staff.capo` |
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
| pitched 音符 | `n<實際音高>`；`accidentalMode` 是強制升、降、重升、重降或本位時寫入 `spell`（#69 加上本位，見 2.2），其他情況不寫（投影時依調號決定，[`schema.md`](schema.md) 8.1） |
| 技巧欄位 | [`schema.md`](schema.md) 第 8 節投影對照的反向；支援範圍以外的列入報告 |
| `beat.lyrics[0]` | `lyric`（截到 32 字元）；第二行以後列入報告 |
| `beat.text` | `text`（截到 64 字元） |
| `beat.dynamics` | `dynamic`：ppp → `pp`、fff → `ff`，其他照名稱（補充） |
| 聲線 | 每個譜表取前 2 條聲線；更多的列入報告 |

- **補充**：bend 轉成最接近的支援形式：依 `bendType` 對應 `bend`、`bendRelease`、`preBend`、`preBendRelease`（`Custom`、`Hold`、`Release`、`PrebendBend` 取最接近的一種並列入報告），半音數取 bend points 的最大值換算後四捨五入，夾在 1–4。
- 列入報告的「不做」項目（[`schema.md`](schema.md) 第 3、8 節）：D.S.、D.C.、Coda、Fine 等跳躍，小節中途變速或變拍，swing feel，速度文字，裝飾音、搖桿、tremolo picking、trill、自由推弦曲線、指法、漸強漸弱，flam、roll、choke，圓滑線、踏板、ottava、跨譜表連桿、和弦指法圖、斜線節奏譜，移調樂器。
- 多小節休止在 alphaTab 的模型裡本來就是一個個小節，照常匯入。

### 2.2 實作（#69）

寫法在 `packages/score-render/src/importScore.ts` 的 `importScore(bytes, fileName)`，回傳 `{ ok: true, score, report }` 或 `{ ok: false, failure }`。

- **failure**：`fileTooLarge`（超過 20 MB，讀檔前檢查）、`unreadable`（alphaTab 讀不了）、`tooManyParts`、`tooManyNonDrumParts`、`tooManyBars`、`tooLarge`（JSON 超過 5 MB）、`invalid`（產生的 `ScoreJSON` 沒通過 `importedScoreSchema`；是這裡的錯，不是檔案的）。數量在轉換前檢查，5 MB 在轉換後檢查。
- **報告**：`ImportReportItem` 是 `{ loss, count, bars }`，`loss` 是 `IMPORT_LOSSES` 之一（代碼，介面文字由 `strings.ts` 對照），`bars` 是發生的小節（從 1 起算，排序、不重複；整份或整個聲部的事是空陣列）。
- **聲部種類**（更正 2.1）：alphaTab 讀 Guitar Pro 6–8 時，會替只有五線譜的譜表補上吉他的調弦（`_assignFingeringForGp6`，為了算指法），而 Guitar Pro 3–5 的每個 track 都有弦。所以「有 `stringTuning`」分不出 fretted：改成「有 `stringTuning` 而且 `showTablature`」。我們自己匯出的 pitched 聲部不顯示 TAB，讀回來仍是 pitched；GP5 的鋼琴 track 只顯示五線譜時也是 pitched，音高取 `realValueWithoutHarmonic`。
- **拼寫**（更正 2.1）：本位（`ForceNatural`）也寫入 `spell`（白鍵的字母）。理由：GP7 會寫出每個音的升降記號，介面輸入的音一律有 `spell`（[`schema.md`](schema.md) 8.1），不寫本位的話，這些音 round-trip 後就少了 `spell`。反過來，沒有 `spell` 的音匯出 GP7 再讀回來時，會帶上它畫出來的拼寫（預設拼寫）；畫法相同，只是之後改調號時不再跟著變。
- **力度**：只在一條聲線裡力度改變的拍點寫 `dynamic`（開頭是 alphaTab 的 `f`），因為 alphaTab 每個拍點都有當時生效的力度。ppp、fff 照 2.1；pppp 以下、ffff 以上取 pp、ff 並列入報告；sf、fz 等不改變生效的力度，列入報告。
- **速度與調號**：第一小節一律寫 `tempo`（和新團譜一樣），之後只在改變的小節寫；`keySig` 只在和 C 大調或前一個生效的調號不同時寫。小節開頭有多個速度 automation 時取最後一個；速度夾在 20–400，超出時列入報告。
- **聲線**：每個譜表的第一條聲線一律寫出，第二條只在有拍點時寫出（和 `docToJson` 相同）。整條聲線都是什麼都沒寫的休止（例如投影補上的整小節休止）讀成空的聲線。alphaTab 的 `isEmpty` 拍點略過。
- **音符**：dead note 的格號是 0 時不寫 `fret`（和介面在空弦上做出的 dead note 相同，投影也一樣用 0）；`beat.tap` 寫在拍點每個音符上；重音的 `Heavy` 讀成 `accent` 並列入報告，`Tenuto` 只列入報告。
- **鼓**：音符的 `percussionArticulation` 是 track 的 `percussionArticulations` 的索引（索引超出時才是 articulation id）；鍵是那個 articulation 的 `id`。
- **段落**：`section.text` 是空的時取 `section.marker`（MusicXML 的 rehearsal 在那裡）。
- **標題與 artist**：alphaTab 讀 MusicXML 時把空白換成不換行空白（`_sanitizeDisplay`），匯入換回一般空白。
- **歌詞**：MusicXML 的 `syllabic` 不在 alphaTab 的模型裡，所以從 MusicXML 讀到的音節不帶結尾的 `-`；Guitar Pro 的歌詞照原樣保留。

## 3. 匯出

- `projectScore` 加上 `Gp7Exporter`，或 `MidiFileGenerator`；前身 `frontend/src/score/exporters.ts:7-16` 有寫法。
- 格式：GP7、MIDI。任何成員都可以用（包含 Viewer），訪客不行（介面沒有按鈕，不是安全邊界）。
- GP7 匯出會寫入拍點上的歌詞（`alphaTab.core.mjs:77553-77558`）。
- 不做 PDF、列印、圖片匯出。
- **補充**：檔名是團譜標題加 `.gp` 或 `.mid`，把檔名不允許的字元換成 `_`；標題是空的時用「未命名」。
- **補充**：Mixer 的設定（靜音、獨奏、音量、速度）不套用到匯出；匯出的是團譜本身。MIDI 匯出不含節拍器與預備拍。

### 3.1 實作（#69）

寫法在 `packages/score-render/src/exportScore.ts`：`exportGp7(json)`、`exportMidi(json)`，都回傳 `Uint8Array`。檔名由 #71 決定。

- **MIDI**：和播放器同一個投影（`projectScore`）、同一個 `MidiFileGenerator`，handler 用標準 MIDI 檔的模式（`AlphaSynthMidiFileHandler(file, true)`）：不寫 alphaTab 自己的休止與節拍器事件，per-note bend 改成聲道的 pitch bend。0 個小節或 0 個聲部時是沒有音符的 MIDI 檔（alphaTab 對這種模型會丟例外，所以不呼叫 generator）。測試比對匯出檔的 note on/off 與播放器模式的產生結果（`importExport.test.ts`）。
- **GP7**：投影之外再補兩件只有檔案需要的事：`score.artist`（畫譜時不設，免得畫出作者）；旋律的空音節（melisma）寫成 `beat.lyrics = [""]`，讀回來才是 `""`（畫譜時照 [`schema.md`](schema.md) 第 6 節不寫）。
- **GP7 的鼓**（alphaTab 1.9 的問題）：投影讓鼓的音符直接帶 articulation id、track 沒有自己的 articulation 清單。這時 alphaTab 的 GP7 writer 寫出整套鼓組，卻把 id 當成清單的索引寫進音符，讀回來變成別的鼓（hi-hat 42 變成清單第 43 個的 agogo）。所以匯出前把每個鼓的音符用到的 articulation 登記到 track（`getOrRegisterPercussionArticulation`），音符改帶索引。alphaTab 的鼓組表不公開，第一次匯出時從「一個沒有清單的鼓聲部」匯出再讀回來取得（`drumKit`）。

## 4. Round-trip 測試

M5 第一張匯入匯出的票必須做：

- 對 GP5、GP7、MusicXML 的樣本做「匯入 → `ScoreJSON` → 投影 → 匯出 → 再匯入」。
- 斷言支援範圍內的內容不變；不支援的內容列進匯入報告。
- 設計時沒有實際跑過 alphaTab 的匯入匯出，所以這是確認檢查（[`testing.md`](testing.md)）。
- **補充**：樣本檔不從網路下載，由這張票自己產生並放進 repo：GP7 用 alphaTab 從一份 `ScoreJSON` 匯出；MusicXML 手寫一份小的 XML；GP5 用一支小的 Python 腳本以 PyGuitarPro 寫出一次（前身 `gp5_writer` 的做法），把產生的檔案提交成 fixture，腳本與執行方式寫在樣本旁的 README。
