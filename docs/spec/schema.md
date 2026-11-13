# 團譜文件的 schema

團譜的 Yjs 文件與它的純資料形式 `ScoreJSON`。設計理由見 ADR 0002 與它的增補。

- 程式裡唯一的真相是 `packages/score-model` 的 zod schema；TypeScript 型別由 zod 推出，`packages/contracts` 只 re-export。
- 本檔與 zod schema 必須一致。改了其中一個，同一個 PR 也要改另一個（規則見 [`README.md`](README.md)）。
- 標「補充」的是設計對質沒有逐條指定、由 spec 撰寫者保守補上的細節。

## 1. 文件的結構

```text
Y.Doc
├── meta   : Y.Map   schemaVersion, title, artist?
├── bars   : Y.Map<小節 id, Y.Map>        每個小節的欄位
└── parts  : Y.Map<聲部 id, Y.Map>        每個聲部的欄位
              └── content : Y.Map<小節 id, Y.Map<"譜表:聲線", Y.Array<Y.Map>>>
                                                             └── 拍點（Y.Map）
                                                                  └── notes : Y.Map<音符鍵, NoteJSON>
```

- 小節、聲部的屬性是 `Y.Map` 的欄位，每個欄位各自後寫者勝。
- 拍點層級的欄位直接放在拍點的 `Y.Map` 上，各自後寫者勝。
- 音符是整顆 JSON（`NoteJSON`），以位置為鍵，同一個音符的同時修改是後寫者勝。
- 每個聲部、每個小節、每條聲線是一個 `Y.Array<拍點>`。
- 小節與聲部的順序由各自的 `order` 欄位決定：fractional index 排序鍵，同鍵時依 id 排（`schema.ts` 的 `ordered`）。
- id 用 `nanoid(10)`（`commands.ts` 的 `newId`）。

### 1.1 內容容器

- 每個聲部對每個小節都有一個「小節內容」`Y.Map`，鍵是 `"<譜表>:<聲線>"`，值是那條聲線的 `Y.Array`。
- **補充**：容器預先建好聲部每個譜表的兩條聲線（`"0:0"`、`"0:1"`；兩個譜表時再加 `"1:0"`、`"1:1"`）。理由：兩個人同時「第一次寫進第二聲線」時，各自建立的 `Y.Array` 會互相覆蓋，一方的拍點無聲消失（ADR 0002 增補）。空的聲線讀起來就是整小節休止，投影時不產生第二聲線。
- 建立小節的人，在同一筆交易裡替所有聲部建好容器；建立聲部的人，在同一筆交易裡替所有小節建好容器（ADR 0002:21，`commands.ts` 的 `addPart`、`insertBars`）。
- 缺少的容器（含缺少的聲線）只由伺服器補齊：在 debounce 過的 `onChange` 裡以參與者身分執行 `fillMissingContent`（`commands.ts`）。客戶端不補。見 [`collab.md`](collab.md)。
- 新團譜的初始內容（聲部、小節、拍號、速度）由伺服器以參與者身分建立，客戶端不建。

## 2. meta

| 欄位 | 形狀 | 說明 |
|---|---|---|
| `schemaVersion` | integer | 系統欄位，指令不改它；見第 9 節 |
| `title` | string，100 字元以內 | 可以共編；伺服器鏡射到 `scores.title` |
| `artist?` | string，1–100 字元 | 可以共編；伺服器鏡射到 `scores.artist`；空字串表示移除 |

- 使用者看得到、可以改的只有 `title` 與 `artist` 兩個欄位。不放作曲者、調性、備註。
- **補充**：`title` 讀取時允許空字串（共編可能把它改空），介面顯示「未命名」；建立團譜與改標題的指令要求 1–100 字元。

## 3. 小節（Bar）

| 欄位 | 形狀 | 語意 |
|---|---|---|
| `id` | string | `bars` 的鍵，不另存成欄位。**補充**：不得是 `__proto__`：小節 id 是 `ScoreJSON` 裡每個聲部 `content` 物件的鍵，而 JSON 物件（與 zod 的 record）不保留這個鍵。讀取時略過這樣的小節（所有聲部一起），並標 `invalidContent`（`bar`） |
| `order` | string | fractional index 排序鍵 |
| `timeSig` | `{ numerator, denominator }` | 每個小節都有，必填 |
| `tempo?` | number | 每分鐘幾個四分音符，「從這小節起」；不寫表示不變；第一小節沒寫時用 120（`projection.ts:16`） |
| `keySig?` | `{ fifths: -7..7, mode: "major" \| "minor" }` | 「從這小節起」；不寫表示不變；全團共用，不做移調樂器 |
| `repeatStart?` | `true` | 反覆開始 |
| `repeatEnd?` | integer ≥ 2 | 反覆結束；值是總共演奏幾次 |
| `voltas?` | `number[]` | 這個小節只在第幾遍演奏 |
| `section?` | string | 段落名稱 |
| `anacrusis?` | `true` | 弱起小節；只在第一小節有意義 |

範圍（補充的數字標在括號裡）：

- `timeSig.numerator`：integer 1–32（補充）；`timeSig.denominator`：1、2、4、8、16、32 之一（補充）。
- `tempo`：20–400 的數字（補充）。
- `keySig.fifths`：integer −7..7，負數是降號數、正數是升號數。
- `repeatEnd`：integer 2–32（下限是設計決定，上限補充）。
- `voltas`：非空、遞增、不重複的 integer，每個 1–8（補充）。
- `section`：1–64 字元（補充）。
- `anacrusis`：出現在第一小節以外時，讀取時忽略（不標 Flag，因為插入小節或同時修改都可能造成）；在最前面插入小節的指令，在同一筆交易裡移除原第一小節的 `anacrusis`（補充）。

不做：D.S.、D.C.、Coda、Fine 等跳躍；小節中途變速或變拍；swing feel；速度文字；多小節休止的資料表示。匯入時遇到這些，列進匯入報告（[`import-export.md`](import-export.md)）。

## 4. 聲部（Part）

| 欄位 | 形狀 | 建立後可否修改 |
|---|---|---|
| `id` | string | `parts` 的鍵 |
| `order` | string | 由 `movePart` 修改 |
| `name` | string | 可改（Command） |
| `kind` | `"fretted" \| "percussion" \| "pitched"` | 不可改 |
| `tuning` | `number[]`：各空弦的 MIDI 音高，第 1 弦（最高）在前；非 fretted 是 `[]` | 可改（Command）。格號不變，所以音高跟著變；弦數不可改 |
| `capo` | integer | 可改（Command） |
| `program` | General MIDI program | 可改（Command） |
| `staves` | `[{ clef }]` | 譜表數不可改；clef 可改（Command，只影響顯示，因為音符以 MIDI 音高為鍵） |
| `content` | 小節 id → `"譜表:聲線"` → 拍點陣列 | 見 1.1 |

各種類的限制：

| | fretted | percussion | pitched |
|---|---|---|---|
| `tuning` | 4–7 個 integer，各 0–127（補充：4–7 弦，和預設表與辨識服務一致） | `[]` | `[]` |
| `capo` | integer 0–24（補充） | `0` | `0` |
| `program` | integer 0–127 | `0`（打擊樂聲道） | integer 0–127 |
| `staves` | 恰好 `[{ clef: "tab" }]` | 恰好 `[{ clef: "neutral" }]` | 1–2 個（補充），clef 是 `"treble"`、`"bass"`、`"treble-8vb"` 之一 |
| 聲線 | 每個譜表 2 條（schema 允許）；介面不提供第二聲線 | 預設一條，允許第二條（手、腳分開） | 每個譜表最多 2 條 |

- `name`：1–64 字元（補充）。**補充**：和 `title` 一樣，讀取時允許空字串（讀不懂的名稱讀成空字串，見第 11 節），所以 `ScoreJSON` 的 `name` 是 0–64 字元；新增聲部與改名的指令要求 1–64 字元。理由：`docToJson` 的結果要能直接存成版本、再用 `jsonToDoc` 還原。
- 譜表數改由 `staves` 決定，不再從 content 推出（現在的 `projection.ts:70-81` 要改）。
- 聲部總共最多 16 個，其中非鼓聲部最多 15 個（理由見 [`playback.md`](playback.md) 的 MIDI 聲道）。
- 弦樂聲部固定只顯示 TAB 加節奏符桿，不做「五線譜＋TAB」並列。

## 5. 聲線鍵

- 形狀 `"<譜表>:<聲線>"`，兩者都從 0 起算；`"0:0"` 是第一個譜表的第一條聲線（`MAIN_VOICE`）。
- 譜表的範圍是 `0..staves.length-1`，聲線是 `0` 或 `1`。超出範圍的聲線鍵，讀取時略過並標 `invalidContent`。

## 6. 拍點（Beat）

| 欄位 | 形狀 | 適用的聲部 |
|---|---|---|
| `id` | string | 全部 |
| `value` | `1 \| 2 \| 4 \| 8 \| 16 \| 32 \| 64`（全音符的幾分之一） | 全部 |
| `dots` | `0 \| 1 \| 2` | 全部 |
| `tuplet?` | `{ actual, normal }`：`actual` 個音占 `normal` 個音的時間 | 全部 |
| `notes` | `Y.Map<音符鍵, NoteJSON>`；空的表示休止 | 全部 |
| `stroke?` | `"down" \| "up"` | fretted |
| `slap?`、`pop?` | `true` | fretted |
| `dynamic?` | `"pp" \| "p" \| "mp" \| "mf" \| "f" \| "ff"` | 全部 |
| `text?` | string，1–64 字元；自由文字（例如和弦名稱），系統不解析也不移調 | 全部 |
| `lyric?` | string，0–32 字元；一拍一個音節，只有一行 | pitched |

- `tuplet`：`actual` integer 2–12、`normal` integer 1–12、兩者不相等（補充）。介面只提供三連音 `{ actual: 3, normal: 2 }`。
- 時值的 tick：全音符 3840（四分音符 960）；附點倍數 1、1.5、1.75；連音乘 `normal / actual`（`flags.ts` 的 `beatTicks`）。
- `lyric` 的空字串表示延長（melisma）。投影時空字串與沒寫都轉成 `beat.lyrics = null`，不要轉成 `[""]`。
- 音節結尾帶 `-` 表示字還沒結束；照原樣存、照原樣投影。alphaTab 照原樣畫出 `-`（`LyricsGlyph.paint`，`alphaTab.core.mjs:57310-57315`），沒有跨音符的連字號圖形；它自己讀 GP 歌詞時也保留 `-`（:12522-12597）。
- `text` 的空字串表示移除，所以存下來的 `text` 至少 1 個字元。
- `slap` 與 `pop` 同一拍點只能有一個：指令保證；兩者同時出現時，讀取時保留 `slap`、略過 `pop` 並標 `invalidContent`（補充）。

## 7. 音符鍵

| 聲部 | 鍵 | 範圍 |
|---|---|---|
| fretted | `s<弦>` | 1 到弦數；第 1 弦是最高音的弦 |
| percussion | `p<id>` | id 是 alphaTab 的 percussion articulation id（Guitar Pro 7 的編號），integer 0–127（補充）。可以是任何一個；介面只提供 18 個（見 7.1） |
| pitched | `n<MIDI 音高>` | integer 0–127 |

- 鍵的格式或範圍不合，或鍵的字首和聲部種類不合：讀取時略過該音符並標 `invalidContent`。
- `n<音高>` 以音高為鍵，所以同一拍點上不能同時有 C♯ 和 D♭（`docs/spike-report.md:312`）。
- 鼓的鍵是 articulation id，所以 snare（`p38`）和 rim shot（`p91`）是不同的鍵，可以同時在一個拍點上。

### 7.1 介面提供的 18 個鼓件

id 對照 `packages/score-render/src/drums.ts:15-34`；譜表位置（0 是最上面那條線，一格是半個間距）與符頭是 alphaTab 內建表的值（`spike-report.md` S6）。

| 鼓件 | 鍵 | 發出的 MIDI 音 | 譜表位置 |
|---|---|---|---|
| kick | `p36` | 36 | 7 |
| snare | `p38` | 38 | 3 |
| side stick | `p37` | 37 | 3 |
| rim shot | `p91` | 38 | 3 |
| hi-hat closed | `p42` | 42 | −1 |
| hi-hat half open | `p92` | 46 | −1 |
| hi-hat open | `p46` | 46 | −1 |
| hi-hat pedal | `p44` | 44 | 9 |
| tom high | `p48` | 48 | 2 |
| tom mid | `p47` | 47 | 4 |
| tom low | `p45` | 45 | 5 |
| tom floor | `p43` | 43 | 6 |
| crash | `p49` | 49 | −2 |
| ride | `p51` | 51 | 0 |
| ride bell | `p53` | 53 | 0 |
| china | `p52` | 52 | −3 |
| splash | `p55` | 55 | −2 |
| cowbell | `p56` | 56 | 0 |

**補充**：`EditorSession` 需要「鼓件 → 譜表位置」才能處理鼓的 `Delete` 與游標位置，但它不能依賴 alphaTab。做法：`score-render` 匯出一份由 alphaTab 內建表產生的純資料對照（`ReadonlyMap<number, number>`），由 Vue 殼傳給 `EditorSession`。對照裡沒有的 id，不受 `Delete` 的「整條線」規則影響，只能用 `Shift+R` 清空拍點。

## 8. 音符（NoteJSON）

| 欄位 | 形狀 | 適用的聲部 | 投影到 alphaTab |
|---|---|---|---|
| `fret?` | integer 0–36 | fretted；只有 `dead` 時可以省略 | `Note.fret`、`Note.string`（alphaTab 從最低弦數起：`弦數 − 弦 + 1`） |
| `dead?` | `true` | fretted | `isDead` |
| `tie?` | `true` | fretted、pitched | `isTieDestination` |
| `ghost?` | `true` | fretted、percussion | `isGhost` |
| `accent?` | `true` | 全部 | `accentuated` |
| `staccato?` | `true` | fretted、pitched | `isStaccato` |
| `legato?` | `true` | fretted；記在起點音上（搥弦、勾弦） | `isHammerPullOrigin` |
| `slideOut?` | `"legato" \| "shift" \| "outUp" \| "outDown"` | fretted | `slideOutType`：`Legato`、`Shift`、`OutUp`、`OutDown` |
| `slideIn?` | `"inBelow" \| "inAbove"` | fretted | `slideInType`：`IntoFromBelow`、`IntoFromAbove` |
| `bend?` | `{ type: "bend" \| "bendRelease" \| "preBend" \| "preBendRelease", semitones: 1..4 }` | fretted | `bendType`：`Bend`、`BendRelease`、`Prebend`、`PrebendRelease`，加上對應的 bend points |
| `vibrato?` | `true` | fretted | `vibrato` |
| `palmMute?` | `true` | fretted | `isPalmMute` |
| `letRing?` | `true` | fretted | `isLetRing` |
| `tap?` | `true` | fretted | 拍點上任一音符有 `tap` 時，`Beat.tap = true` |
| `harmonic?` | `"natural" \| "pinch" \| "artificial"` | fretted | `harmonicType`：`Natural`、`Pinch`、`Artificial`；`artificial` 的 `harmonicValue` 是 12（補充） |
| `spell?` | 見 8.1 | pitched | `accidentalMode`（`projection.ts:100-117`） |

- 欄位出現在不適用的聲部種類，或值超出範圍：讀取時略過整個音符並標 `invalidContent`。
- 沒有 `fret` 而且沒有 `dead` 的 fretted 音符：讀不懂，略過並標記。現在的投影遇到沒有格號的音會丟掉（`projection.ts:127`），要改成 dead note 可以沒有格號。
- `bend.semitones`：integer 1–4。新設定的 bend 預設 2 個半音（補充，見 [`keymap.md`](keymap.md)）。
- 拍點層級的投影對照：`stroke` → `Beat.brushType`（`down` → `BrushDown`、`up` → `BrushUp`）；`slap`、`pop` → `Beat.slap`、`Beat.pop`；`dynamic` → `Beat.dynamics`；`text` → `Beat.text`；`lyric` → `Beat.lyrics`。
- 小節層級的投影對照：`keySig` → 每個聲部每個 `Bar` 的 `keySignature` 與 `keySignatureType`（`MasterBar` 上的同名欄位在 1.9 已 deprecated，`alphaTab.d.ts:11229-11250`）；`repeatStart` → `MasterBar.isRepeatStart`；`repeatEnd` → `repeatCount`；`voltas` → `alternateEndings` 的位元；`section` → `MasterBar.section`；`anacrusis` → `isAnacrusis`；`tempo` → 小節開頭的速度 automation。
- 以上每一項 alphaTab 1.9 都有對應的欄位：`Beat` 的 `slap`、`pop`、`tap`、`brushType`、`dynamics`、`text`、`lyrics`（`alphaTab.d.ts:5018-5062,5203`），`Note` 的 `accentuated`（:13283）等，`MasterBar` 的 `isAnacrusis`（:11331）、`repeatCount`、`alternateEndings`、`section`。

不做：

- fretted：裝飾音、搖桿、tremolo picking、trill、自由推弦曲線、指法、漸強漸弱。
- percussion：flam、roll、choke。
- pitched：圓滑線、踏板、ottava、跨譜表連桿、裝飾音、和弦指法圖、斜線節奏譜。

### 8.1 Pitched 的拼寫

- `spell` 的格式：一個大寫音名 `A`–`G`，後面接 `""`、`"#"`、`"b"`、`"##"`（或 `"x"`）、`"bb"` 之一，例如 `"C#"`、`"Db"`、`"F##"`、`"Cx"`、`"Bbb"`。讀取時 `"x"` 與 `"##"` 同義；指令寫入時用 `"##"`（補充）。
- 拼寫必須和音符鍵的音高相符（音名加升降後的 pitch class 等於 `音高 mod 12`）。不相符時，投影忽略 `spell`、改用預設拼寫，不標 Flag（補充）。
- **預設拼寫**（沒有 `spell` 時，投影依該小節生效的 `keySig` 決定黑鍵怎麼寫）：`fifths > 0` 寫成升，`fifths < 0` 寫成降。**補充**：`fifths = 0`（C 大調、A 小調）寫成升。
- **補充**：從介面輸入的 pitched 音一律寫入 `spell`，所以之後改調號不會改變已經寫好的音；只有匯入或其他來源的音可能沒有 `spell`。

## 9. `schemaVersion` 與加法規則

- 完整 schema 發布時是 `schemaVersion: 1`（補充）。M0 沒有持久化任何文件（`collab.ts:17-25` 只存在記憶體），不需要從 M0 遷移；現在的 `SCHEMA_VERSION = 1`（`schema.ts` 的 `SCHEMA_VERSION`）照用。
- 新增 optional 欄位屬於加法改動，**不升** `schemaVersion`。條件：同一個 PR 也改本檔、ADR 0002 的增補（形狀有變時）與 zod schema。
- 讀到不認得的欄位：忽略，不標 Flag，並原樣保留。改寫音符的指令以儲存的原值為底（`{ ...原值, 修改 }`），不以 zod 解析後的值為底；否則部署新版之後還開著的舊分頁，會把新欄位刪掉。
- 非加法的改動（改名、改形狀、改語意、刪欄位）要升 `schemaVersion` 並寫遷移。agent 不得自行決定，要開 `ready-for-human` 票。
- 客戶端遇到比自己新的 `schemaVersion`：以唯讀開啟（`EditorSession` 的唯讀旗標），並顯示「這份團譜由較新的版本建立，請重新整理頁面」（ADR 0002:22）。
- **補充**：伺服器載入時發現文件比自己新：不遷移、不執行 `fillMissingContent`，這份文件的所有連線都設成 readOnly，並寫 log。

## 10. 遷移

遷移做兩面，M1a 就建好掛點。

- **遷移清單**：`score-model` 裡一份依版本排序的清單，每一項是 `{ from, to, doc(doc: Y.Doc): void, json(json: unknown): unknown }`。`doc` 與 `json` 兩面的語意必須相同。
- **`Y.Doc` 那一面**：伺服器在 `onLoadDocument` 載入狀態之後，以參與者身分、在一筆交易裡依序跑 `doc` 遷移，最後把 `meta.schemaVersion` 設成目前的版本。不要在 `onStoreDocument` 裡改文件，否則會再觸發一次儲存。
- **`ScoreJSON` 那一面**：版本存的是 `docToJson` 的結果，帶著當時的 `schemaVersion`。讀取版本時，伺服器先依序跑 `json` 遷移，回傳目前版本的 JSON（補充：由伺服器遷移，客戶端拿到的一律是目前的版本）。還原、預覽都用遷移後的 JSON。
- **補充**：`schemaVersion` 讀不懂（沒寫、不是 0 以上的整數）時，兩面都當成目前的版本，和讀取時相同：不遷移，也不會因此被判定為較新。
- **補充**：找不到某一步的遷移（部署漏了遷移，或文件被寫成一個沒有遷移可走的舊版本）時，`migrateDoc` 丟例外、不改文件；伺服器寫 error log，這份文件比照「比自己新」處理：不執行 `fillMissingContent`，所有連線設成 readOnly，直到部署補上那一步。`migrateJson` 同樣丟例外：伺服器對那個版本回應錯誤，不能預覽或還原。
- **`jsonToDoc`**：放在 `score-model`，把 `ScoreJSON` 寫進一份 `Y.Doc`。匯入與還原共用；保留 JSON 裡的 id，依陣列順序重新產生 `order`，建好所有內容容器。
- **測試**（M1a）：一份假的舊版 fixture（`schemaVersion: 0`）與一個只在測試裡註冊的 0 → 1 遷移，兩面都要測：`Y.Doc` 從舊狀態遷移後的 `docToJson`，等於 JSON 遷移後的結果。正式的遷移清單在第一版是空的。

## 11. 讀取時容錯

伺服器不做語意驗證（Editor 視為可信任，見 ADR 0002 增補）。容錯在讀取時做：

- `docToJson` 對每個拍點、每個音符用 zod 的 `safeParse`：讀不懂的跳過，記成 `invalidContent` Flag，永遠不丟例外。
- 小節：
  - `order` 不是字串：整個小節略過並標記。小節是全域的，所以所有聲部一起略過這個小節，不會錯位。
  - `timeSig` 讀不懂：當成 4/4，並標記。
  - `tempo`、`keySig`、`repeatStart`、`repeatEnd`、`voltas`、`section` 讀不懂：當成沒寫，並標記（補充）。
- 聲部：
  - `kind` 讀不懂：整個聲部略過，並標記。
  - fretted 的 `tuning` 讀不懂：整個聲部略過，並標記（補充：沒有調弦就無法放置音符）。
  - `name` 讀不懂當成空字串、`capo` 當成 0、`program` 當成該種類的預設、`staves` 當成該種類的預設，各自標記（補充）。種類的預設（補充）：`program` 是 fretted 25、percussion 0、pitched 0；`staves` 是一個譜表：`tab`、`neutral`、`treble`。非 fretted 的 `tuning` 讀不懂時當成 `[]`，並標記。
  - `order` 不是字串：整個聲部略過，並標記（補充，和小節相同）。
  - `content` 不是 `Y.Map`：讀成沒有內容，並標記；某個小節的內容不是 `Y.Map`：那個小節讀成沒有內容，並標記（補充）。
- 聲線鍵超出範圍：該聲線略過，並標記。
- 拍點讀不懂：略過該拍點（後面的拍點照常讀），並標記。音符讀不懂：略過該音符，並標記。
- 不認得的欄位：忽略，不標記（第 9 節）。
- `meta`（補充）：`schemaVersion` 讀不懂當成目前的版本，`title` 讀不懂當成空字串，`artist` 讀不懂當成沒寫，讀不懂時各自標記。沒寫的欄位不標記：`schemaVersion` 沒寫當成目前的版本、`title` 沒寫當成空字串（還沒建立團譜的空文件就是這樣）。
- 讀取的結果另外附上 `invalidContent` 的清單（`readScore`）；`docToJson` 只回傳 `ScoreJSON`。Flag 的 `what` 是讀不懂的那一層：`meta.<欄位>`、`bar`、`bar.order`、`bar.<欄位>`、`part`、`part.order`、`part.<欄位>`、`content`、`voice`、`beat`、`beat.pop`、`note`（補充）。
- 驗證結果用 `WeakMap` 快取，鍵是拍點的 `Y.Map`；某個小節有變動時，作廢那個小節的快取，只有變動的小節重新驗證。**補充**：作廢在交易結束、任何 observer 被呼叫之前做（Yjs 的 `beforeObserverCalls`，依 `transaction.changed`），所以在 observer 裡讀取也看得到這次的修改；交易進行中讀取時不用快取。
- 伺服器端的讀取（建立版本、鏡射標題）用同一個函式。
- 實測（Node 24、i9 桌機）：不快取時，4,000 個拍點逐一 `safeParse` 中位數 6.5 ms、p95 7.2 ms、第一次 20 ms，是 `docToJson` 本身 1.8 ms 的 3.6 倍。

`invalidContent` Flag 的形狀見 [`flags.md`](flags.md)。

## 12. `ScoreJSON`

`docToJson` 的輸出，依小節順序與聲部順序排列；版本、匯出、匯入、測試都讀寫這個形狀。`order` 不出現（由陣列順序表示）。

```ts
interface ScoreJSON {
  schemaVersion: number;
  title: string;
  artist?: string;
  bars: BarJSON[];
  parts: PartJSON[];
}

interface BarJSON {
  id: string;
  timeSig: { numerator: number; denominator: number };
  tempo?: number;
  keySig?: { fifths: number; mode: "major" | "minor" };
  repeatStart?: true;
  repeatEnd?: number;
  voltas?: number[];
  section?: string;
  anacrusis?: true;
}

interface PartJSON {
  id: string;
  name: string;
  kind: "fretted" | "percussion" | "pitched";
  tuning: number[];
  capo: number;
  program: number;
  staves: { clef: "tab" | "neutral" | "treble" | "bass" | "treble-8vb" }[];
  /** 小節 id → "譜表:聲線" → 拍點。空的聲線可以省略。 */
  // docToJson 的寫法（補充）：每個有內容容器的小節都在；每個譜表的第一條聲線（"0:0"、"1:0"）一律寫出，
  // 空的就是 []；第二條聲線只在有拍點時寫出，所以空的第二聲線投影時不產生聲線。
  content: Record<string, Record<string, BeatJSON[]>>;
}

interface BeatJSON {
  id: string;
  value: 1 | 2 | 4 | 8 | 16 | 32 | 64;
  dots: 0 | 1 | 2;
  tuplet?: { actual: number; normal: number };
  notes: Record<string, NoteJSON>;
  stroke?: "down" | "up";
  slap?: true;
  pop?: true;
  dynamic?: "pp" | "p" | "mp" | "mf" | "f" | "ff";
  text?: string;
  lyric?: string;
}
```

`NoteJSON` 的欄位見第 8 節。Phrase fragment 的形狀見 [`phrases.md`](phrases.md)。

## 13. 長度與數量上限

所有上限都用 zod 檢查。字元數以 JavaScript 字串的 `length` 計算（補充）。1 MB 是 1,048,576 bytes（補充）。

| 項目 | 上限 |
|---|---|
| `title`、`artist` | 各 100 字元 |
| 拍點的 `text` | 64 字元 |
| 歌詞音節 `lyric` | 32 字元 |
| `section`（補充） | 64 字元 |
| 聲部的 `name`（補充） | 64 字元 |
| 聲部 | 總共 16 個，其中非鼓聲部最多 15 個 |
| 小節 | 1000 個。匯入用這個上限；**補充**：插入小節、放置樂句的指令也不得讓總數超過 1000 |
| 匯入的 `ScoreJSON` | 5 MB（UTF-8 序列化後；`importedScoreSchema`） |
| 單一樂句的 JSON | 1 MB |
| WebSocket 單則訊息 | 8 MB |

- **聲部與小節的數量上限只約束指令與匯入**（host 在 2026-11-13 裁定）：兩人同時新增小節或聲部，總數可能超過上限；這樣的團譜照常讀取，它的版本也必須能預覽、還原。所以 `scoreSchema`（版本、`migrateJson`、`jsonToDoc` 用的）不檢查數量，`importedScoreSchema`（匯入用）才檢查數量與 5 MB。指令端的拒絕在插入小節與聲部管理的票裡做（#22、#24）。
