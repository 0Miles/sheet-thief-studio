# Command、Cursor、Selection

編輯模型：游標、選取、每一個 Command 的語意、復原。鍵位見 [`keymap.md`](keymap.md)，文件的形狀見 [`schema.md`](schema.md)。標「補充」的是 spec 撰寫者保守補上的細節。這份文件提到的鍵用 Windows、Linux 的寫法；macOS 的對應鍵見 [`keymap.md`](keymap.md) 第 2 節。

## 1. 通則

- Command 是 `score-model` 裡的純函式 `(doc, cursor 或 selection, args) → cursor`。
- 每一個 Command 是一筆 Yjs 交易（origin 是 `LOCAL`）、一個復原步驟。
- Command 不碰 DOM，也不碰 renderer。
- `EditorSession`（`packages/score-editor`）把按鍵對應到 Command，依聲部種類分派。它帶著唯讀旗標：唯讀時，任何會改動文件的 Command 都被拒絕（見 [`views.md`](views.md)）。
- 不自動拆拍、不自動跨小節連結；超出拍號只標 Flag（ADR 0002）。
- 指令改寫音符時，以儲存的原值為底，保留不認得的欄位（[`schema.md`](schema.md) 第 9 節）。**補充**（#103）：原值是它自己的欄位（`ownFields`，不算 `__proto__`），判斷與寫入都從這份複本來，所以每個成員做出相同的改寫。
- **補充**（#102）：指令不寫出巢狀超過 `MAX_VALUE_DEPTH`（64 層，[`schema.md`](schema.md) 第 13 節）的值。改寫儲存的音符時，`ownFields` 丟掉會讓音符超過上限的欄位，所以改寫順便把它修好（例如在這樣的音符上打格號）；讀不懂的音符照舊不被技巧鍵改動（第 5.4 節）。呼叫端給的值經 `writableCopy` 複製（每一層去掉 `__proto__`），超過上限時不寫入，回傳值和其他「不做事」的情形相同：`setNote`、`setFret` 與 `NoteToggle`（游標不變、沒有交易；選取上任一音符超過上限就全部不寫）、`insertBeat` 的 tuplet（不建立拍點）、`BeatChange` 的 tuplet 與拍點記號（不寫入）、`insertBars` 的拍號（回傳空陣列）。`addPart` 沒有「不做事」的回傳值，調弦或譜表超過上限時丟 `RangeError`、不建立聲部。小節、聲部、團譜欄位的指令（`setKeySig`、`setTuning`、`setTimeSig` 等）寫入 zod 驗證後的值，深度本來就在上限內。`createScore` 的標題、`setTitle`、`setArtist`（只檢查長度）、`addPart` 的 `name`、`kind`、`capo`、`program`，以及 `setDuration` 的 `value`、`dots`，則是照型別直接寫入的字串或數字，執行期不再驗證：純值沒有巢狀，不會超過上限；它們的範圍與長度檢查是各自的指令的事，不是深度的事。萬一呼叫端傳了別的東西，伺服器的深度檢查（[`collab.md`](collab.md) 第 9 節）仍會擋下過深的值。

Command 分三類：

| 類別 | 作用範圍 | 例子 |
|---|---|---|
| **內容操作**（content operation） | 只動游標或選取所在的那一個聲部 | 輸入音符、技巧、時值、插入或刪除拍點、清空、剪下、貼上、存成樂句、放置 |
| **結構操作**（structural operation） | 整份團譜的小節，所有聲部一起 | 插入或刪除小節、改拍號、速度、調號、段落名稱、反覆、volta、弱起 |
| **設定**（補充：設計對質沒有把聲部管理歸類） | 聲部或團譜本身 | 新增、刪除、排序聲部；改聲部名稱、調弦、capo、音色、譜號；改標題、演出者；還原版本 |

結構操作在介面上要看得出它影響所有聲部，例如選取框以虛線橫跨所有聲部。

## 2. Cursor

```ts
interface Cursor {
  partId: string;
  barId: string;
  voice: string;           // "譜表:聲線"
  beatId: string | null;
  at: "on" | "after";
  line: number;
}
```

- `at: "on"`：游標在 `beatId` 那個拍點上。
- `at: "after"`：**附加位置（Append slot）**。錨點 `beatId` 是進入附加位置時那條聲線的最後一個拍點。
- 空聲線的附加位置是 `{ beatId: null, at: "after" }`，新拍點插在 index 0。
- 沒有「第一個拍點之前」這個位置。
- `line`：
  - fretted：弦，1 到弦數，1 是最高音的弦。
  - percussion、pitched：譜表位置，範圍 −4..12；0 是最上面那條線，8 是最下面那條，一格是半個間距（`navigation.ts` 的 `lineRange`、`geometry.ts` 的 `lineOffset`）。

**為什麼一定要有錨點**：新拍點插在「自己的上一個拍點之後」，Yjs 以左鄰項目當錨，所以兩個人同時在同一小節輸入時，各自的拍點保持成段（ADR 0002:8；`packages/score-model/tests/coediting.test.ts` 的「beats typed by two members in the same bar at the same time are all kept, each run together」、「two members typing six beats each in the append slot of the same bar keep each their beats together, in the order typed」與「whatever three members do, in whatever order their changes arrive, they end with the same score」）。如果附加位置只是「聲線尾端」，兩人的拍點會交錯。

- 錨點之後被別人附加了拍點：附加位置畫在錨點之後、他人拍點之前；在附加位置輸入，新拍點也插在那裡。
- 錨點被刪除（別人刪除或自己復原）：游標用 `settleCursor` 重新解析（`navigation.ts` 的 `settleCursor`）。**補充**：錨點不在了，就落到那條聲線目前的最後一個拍點之後；聲線變空就是空聲線的附加位置；聲部或小節不在了，回到第一個聲部第一小節的第一個位置。
  - **補充**（#22）：寫法是 `EditorSession` 在 `settleCursor` 回傳 null 時改用 `commands.ts` 的 `startOfScore(doc, lines)`：第一個畫得出來的聲部（種類讀得懂）的第一小節第一個位置，`line` 用這個成員在那個聲部上次的 `line`，沒有記錄就用 `startLine`。`settleCursor` 本身仍然回傳 null，所以移動的函式在聲部或小節不在時不動（第 3 節 #20 的補充）。殼在游標落到隱藏的聲部時，照 [`views.md`](views.md) 第 6 節移到第一個顯示中的聲部。
- **補充**：游標所在的拍點被刪除（別人刪除或自己復原）：落在接替它位置的拍點上，也就是它後面的那個拍點；它原本是最後一個拍點時，落在前一個拍點；聲線變空就是空聲線的附加位置 `{ beatId: null, at: "after" }`。做法：`EditorSession` 每次移動游標時用 `beatPositionOf` 記下拍點的位置（Yjs 的相對位置），拍點不在了就交給 `settleCursor` 解析。
- 其他人的游標在遠端修改之後，同樣用 `settleCursor` 重新解析。**補充**：看的人這邊沒有那位成員的拍點位置，所以不帶位置解析：那位成員所在的拍點被刪除時，在看的人這邊先落在那條聲線的最後一個拍點，直到那位成員自己的 session 送出新的 presence。
- **補充**：`EditorSession` 記住每個聲部上次的 `line`；第一次進入某個聲部時，fretted 是 1，其他種類是 4（中間那條線）。換到弦數較少的聲部時夾在範圍內。
  - **補充**（#20）：起始的 `line` 由 `schema.ts` 的 `startLine(kind)` 給出（旁邊是 `lineRange`、`voicesOffered`；讀不懂種類的聲部都當成譜表），`cursorAt` 沒給 `line` 時用它（Vue 殼放第一個游標時也是）。`Ctrl+↑/↓` 換到另一個聲部時，`moveByStaff` 取 `EditorSession` 記下的那個聲部的 `line`，沒有記錄就用 `startLine`，再夾在範圍內。

## 3. 移動

移動游標**永遠不產生 Command**，也不改動文件。

| 動作 | 規則 |
|---|---|
| `→` | 到下一個拍點。從最後一個拍點：小節**未滿**就進附加位置；**已滿或超過**，直接到下一小節的第一個位置。從附加位置：到下一小節的第一個位置。在最後一小節的尾端：不動 |
| `←` | 到上一個拍點。從附加位置：回到錨點。從第一個拍點：到上一小節的最後一個拍點（補充：不進上一小節的附加位置；上一小節是空聲線時，進它的附加位置）。在第一小節的開頭：不動 |
| `Home` | 小節的第一個位置（第一個拍點；空聲線是附加位置） |
| `End`（補充） | 小節裡用 `→` 走得到的最後一個位置：小節未滿是附加位置，已滿或超過是最後一個拍點 |
| `Ctrl+←` `Ctrl+→` | 上一個／下一個小節的第一個位置 |
| `↑` `↓` | fretted：上一條／下一條弦。percussion：譜表位置。pitched：依自然音階上下（見 [`keymap.md`](keymap.md)） |
| `Ctrl+↑` `Ctrl+↓` | 依序經過各譜表，再到上一個／下一個聲部 |
| `Alt+1` `Alt+2` | 切換到目前譜表的第 1／第 2 條聲線 |
| 點擊譜面 | 只移動游標（`hitTest`，由 Vue 殼轉成 Cursor） |

- 「小節未滿」：那條聲線的拍點 tick 總和小於拍號的長度。
- 「下一小節的第一個位置」：它的第一個拍點；空聲線則是附加位置。
- 新增小節一律要明確操作（`Ctrl+Insert` 一類的鍵，或譜尾的「＋小節」按鈕）。
- **補充**：`Ctrl+↑/↓` 與 `Alt+1/2` 換到另一條聲線時，留在同一個小節，落在「包含目前拍點起點 tick」的那個拍點上；那條聲線沒有拍點涵蓋這個 tick 時，落在它用 `End` 會到的位置。
  - **補充**（#20）：在附加位置上，「目前的 tick」是錨點拍點的結尾；空聲線是小節的開頭。時值讀不懂的拍點長度算 0（讀取時被略過）。
  - **補充**（#20）：`Ctrl+↑/↓` 依 `staves` 的順序經過聲部的各個譜表；過了最後一個（或第一個）譜表，到下一個聲部的第一個譜表（或上一個聲部的最後一個譜表）。聲線的編號不變（第二聲線到下一個譜表的第二聲線），目標聲部不提供時（fretted）落在第一聲線。讀不懂種類的聲部不畫出來，跳過。在第一個聲部的第一個譜表按 `Ctrl+↑`、最後一個聲部的最後一個譜表按 `Ctrl+↓`：不動。寫法是 `navigation.ts` 的 `moveByStaff`、`moveToVoice`；`Home`、`End` 是 `moveToBarStart`、`moveToBarEnd`。
  - **補充**（#20）：`Ctrl+←/→`、`Home`、`End`、`Ctrl+↑/↓`、`Alt+1/2` 都先用 `settleCursor` 解析游標，和 `←`、`→` 一樣；游標的聲部或小節不在了就不動（不會跳到第一小節）。
- **補充**：fretted 聲部按 `Alt+2` 不動，並提示「弦樂聲部只有一條聲線」（介面不提供第二聲線）。做法（#20）：`EditorSession` 的 `onHint` 送出 `"oneVoice"`，殼顯示 `strings.ts` 的 `score.hints.oneVoice`；fretted 只提供第一聲線，由 `schema.ts` 的 `voicesOffered` 決定；`navigation.ts` 的 `moveToVoice` 對不提供的聲線回傳 `VOICE_NOT_OFFERED`（#22 把字串哨兵改成具名的常數與型別 `VoiceNotOffered`）。

## 4. Selection

不做跨聲部的選取。

| 種類 | 範圍 | 延伸 |
|---|---|---|
| **Beat range（拍點範圍）** | 同一聲部、同一聲線、同一小節內連續的拍點 | `Shift+←/→`。延伸越過小節邊界時，自動升級成小節範圍（從起點的小節到新的小節） |
| **Bar range（小節範圍）** | 同一聲部的連續小節，包含所有聲線 | `Shift+Ctrl+←/→` |

- 選取有一個起點（anchor）和一個終點（focus），終點跟著游標。
- **補充**：不帶 `Shift` 的移動、`Esc`、或任何不作用在選取上的 Command 之後，選取取消。
- Presence 裡的選取形狀（補充）：

  ```ts
  type Selection =
    | { kind: "beats"; partId: string; barId: string; voice: string; anchorBeatId: string; focusBeatId: string }
    | { kind: "bars"; partId: string; anchorBarId: string; focusBarId: string };
  ```

- **補充**（#21）：延伸的細節。規則寫在 `packages/score-model` 的 `selection.ts`（`extendSelection`），`EditorSession` 照它更新選取；測試在 `packages/score-editor/tests/selection.test.ts`。
  - 沒有選取時，從游標所在的拍點（`Shift+←/→`）或小節（`Shift+Ctrl+←/→`）開始。游標在附加位置時，它的拍點是錨點，也就是那條聲線的最後一個拍點；空聲線沒有拍點可選，`Shift+←/→` 不建立拍點範圍。
    - **補充**（#20）：空聲線的 `Shift+←/→` 照升級規則處理：游標照 `←`、`→` 離開這個小節時（樂譜中段），建立從這個小節到游標小節的小節範圍；游標留在同一個小節時（譜的開頭按 `Shift+←`、譜的結尾按 `Shift+→`），不建立選取。測試在 `selection.test.ts` 的「in an empty voice in the middle of the score」。
  - `Shift+←/→` 的游標照 `←`、`→` 移動（第 3 節，包括 5.1 剛輸入的拍點）。游標進入附加位置時，終點是它的錨點。
  - `Shift+Ctrl+←/→` 的游標照 `Ctrl+←/→` 移到上一個／下一個小節的第一個位置（`navigation.ts` 的 `moveByBar`）；在譜的兩端不動，範圍保留。拍點範圍用它延伸時，從拍點範圍的小節起。
  - 升級成小節範圍之後就一直是小節範圍：`Shift+←/→` 照樣移動游標，終點是游標的小節；回到起點的小節時是那一個小節的範圍。
  - 結束選取的動作：不帶 `Shift` 的移動（含 `↑`、`↓`、`Home`、`End`、`Ctrl+←/→`、`Ctrl+↑/↓`、`Alt+1/2`；fretted 聲部的 `Alt+2` 什麼都不做，選取也不變）、`Esc`、點譜面、復原與重做，以及其他不作用在選取上的 Command（輸入音符、`Insert`）。被唯讀拒絕的 Command 沒有執行，選取不變。
  - 選取作用的 Command 目前有 `Delete`（5.6）、#26 的開關型技巧：dead、ghost、accent、staccato、vibrato、palmMute、letRing、tap（5.4），#20 的時值（`+`、`-`、`.`、`Shift+T`，5.3）與 `Shift+R`（5.6），以及 #30 的拍點記號：stroke、slap／pop、dynamic（5.4）；選取在它們之後保留。`text`（5.5）只作用在游標拍點，存入後選取結束。其餘技巧作用在選取範圍的規則還沒做，在那之前它們只作用在游標拍點，並結束選取。
  - `Delete` 之後，選取的拍點或小節還在時選取保留（所以拍點範圍再按一次 `Delete` 就刪除那些休止）；拍點被刪除時選取結束，游標落在接替它們位置的拍點上，沒有時落在附加位置（同 5.2 的 `deleteBeat`）。小節範圍清空後，游標所在的聲線變空，游標落在空聲線的附加位置。
  - 起點或終點的拍點、小節或聲部不在了（別人刪除、自己復原），選取結束（`settleSelection`）。
  - 唯讀編輯視圖也可以選取（[`views.md`](views.md) 第 4 節）；`Delete` 被拒絕。
  - 選取框：拍點範圍是一個框，從第一個拍點到最後一個拍點、蓋住那條聲線的譜表；小節範圍在每一行譜（system）各一個框，從那一行的第一個選取小節到最後一個、蓋住這個聲部的所有譜表。上下延伸到外側的線（弦或譜線）上的游標所及之處。位置由 `ScoreRenderer.boundsOfSelection` 給出（`geometry.ts` 的 `selectionRects`），殼照 [`views.md`](views.md) 第 9 節避開保留區域。

## 5. 內容操作

### 5.1 輸入音符

| 聲部 | 鍵 | 語意 |
|---|---|---|
| fretted | `0`–`9` | 在游標的弦與拍點寫入格號（`{ ...原值, fret }`） |
| percussion | 鼓件字母、`1`–`4` | 切換：拍點上沒有這個鼓件就加上，有就移除 |
| pitched | `A`–`G` | 在最靠近游標位置的那個八度輸入該音名的音，依調號套用升降；拍點上已經有音時，加入和弦音 |

- **兩位數格號**：600 ms 內在同一個拍點、同一條弦上輸入的兩個數字，合成一個格號、一個復原步驟；合起來超過 36 時，第二個數字當成新的一次輸入（`packages/score-editor/src/session.ts` 的 `TWO_DIGIT_WINDOW`、`MAX_FRET` 與 `typeDigit`；測試在 `packages/score-editor/tests/typing.test.ts`）。
  - **補充**（#20）：復原步驟在哪裡分開由 `EditorSession` 決定，不靠時鐘：`UndoManager` 的 `captureTimeout` 是無限大，這個成員的每一筆交易之前呼叫 `stopCapturing()`，只有第二個數字那一筆不呼叫，所以併進第一個數字的步驟。別人的修改夾在兩個數字之間，不影響合併；這個成員不經按鍵的修改（例如之後的面板）或點譜面夾在中間時，結束等待，第二個數字當成新的一次輸入。
- **在附加位置輸入**：建立一個新拍點並寫入音符，是一個 Command。新拍點的時值取錨點拍點的時值（`value`、`dots`、`tuplet`）；沒有錨點時是四分音符。輸入後游標移到新拍點（`at: "on"`），下一次 `→` 以它為新的錨點。
  - **補充**：別人的拍點已經接在新拍點之後時也一樣。游標還停在新拍點上（只換弦、換線不算離開）時，`→` 把它當成聲線的最後一個拍點：小節未滿就進它的附加位置，已滿或超過就到下一小節（`navigation.ts` 的 `moveFromAppendedBeat`）。否則 `→` 會走到別人的拍點上，同時打譜的兩人的拍點就不再成段。游標離開新拍點之後，`→` 照第 3 節。`Insert` 在附加位置建立的拍點也一樣。
- 在既有拍點上輸入：游標留在原拍點（這樣才能疊和弦），fretted 與 pitched 可以接著換弦、換線再輸入。
- **補充**：percussion 切換之後，`line` 移到該鼓件的譜表位置（[`schema.md`](schema.md) 7.1）。
  - **補充**（#44）：寫法是 `commands.ts` 的 `toggleDrum(doc, cursor, id)`：拍點上沒有 `p<id>` 就加上 `{}`，有就連同它的 ghost、accent 一起移除；在附加位置上和格號一樣建立新拍點，游標移到新拍點，下一次 `→` 以它為錨點。表裡沒有的 id `line` 不動。測試：`packages/score-editor/tests/drums.test.ts`、`apps/web/e2e/drums.spec.ts`。
- **pitched 的音高**：`score-model` 有一個純函式，由「clef 加譜表位置」得出自然音的音高；`A`–`G` 在所有同名的音裡，取和游標位置的自然音相差最少音級的那一個（7 個音名不會等距，所以沒有平手）。再依該小節生效的 `keySig` 套用升降（例如 G 大調的 F 變成 F♯），寫入 `spell`。**補充**：輸入後 `line` 移到新音所在的譜表位置。
- 音高超出 0–127 時不輸入。
- **補充**（#48）：寫法在 `packages/score-model` 的 `pitch.ts`（純函式）與 `commands.ts` 的 `enterNote(doc, cursor, letter)`，鍵是 `bindings.ts` 的 `pitch` 綁定（帶 `letter`）。
  - 「clef 加譜表位置」的自然音是 `naturalAt(clef, line)`：最上面那條線在 `treble` 是 F5、`bass` 是 A3、`treble-8vb` 是 F4（照高音譜號寫、低一個八度發聲），往下每一格一個音級。
  - 調號的升降套在音名上（`enteredPitch`）：升號依 F C G D A E B、降號依 B E A D G C F 的順序，取 `fifths` 個；`mode` 不影響（小調用關係大調的調號）。所以 C♯ 大調的 B 是 B♯（音高是上一個八度的 C）、C♭ 大調的 F 是 F♭。寫入的 `spell` 就是這個音名加升降，一律寫入（[`schema.md`](schema.md) 8.1）。調號是游標小節生效的那一個，從文件讀，讀不懂的調號當成沒寫（`keySigIn`，和 `keySigsOf` 一樣）；譜號取游標聲線所在的譜表，`staves` 讀不懂時是預設的高音譜表。
  - 拍點上已經有同一個音符鍵的音（例如 C♯ 之後輸入 D♭）：後輸入的取代前一個，以原值的自有欄位（`ownFields`）為底、換成新的 `spell`；拼寫相同時不寫入（沒有交易、沒有復原步驟）。原值讀不懂時不保留它的欄位，寫成只有 `spell` 的音。
  - 游標拍點是讀取時被略過的拍點時不動。輸入後 `line` 移到新音的譜表位置，夾在 `lineRange`（−4..12）裡：從 −4 輸入 E 是 E6，畫在 −6，游標停在 −4。實際上從 −4..12 的位置輸入的音都在 0–127 之內（最低是低音譜表 12（C2）往下三級的 G♭1，音高 30：從那裡 F 往上取到 F2；最高是高音譜表 −4（C6）往上三級的 F♯6，音高 90），超出範圍的檢查是防呆。
  - 在附加位置上和格號一樣建立新拍點（`EditorSession` 的 `markAppended`），下一次 `→` 以它為錨點。

### 5.2 插入與刪除

| Command | 鍵 | 語意 |
|---|---|---|
| `insertBeat` | `Insert` | 在游標拍點**之前**插入一個休止拍點，時值和游標拍點相同；在附加位置上就是附加（時值規則同 5.1）。游標移到新拍點 |
| `deleteNote` | `Delete`（拍點上有音） | 刪掉游標那條線上的音符：fretted 是那條弦；pitched 是畫在那條線上的所有音（補充；#48：`noteKeysAt` 給出的鍵，一個 Command，見 5.8 的補充）；percussion 是畫在那條線上的**所有**鼓件（補充，#44：`noteKeysAt` 給出的鍵，一個 Command；表裡沒有的 id 沒有線，不刪）。三種都已做 |
| `deleteBeat` | `Delete`（空拍點） | 刪掉拍點 |

- percussion 的 `Delete` 刪整條線，理由：好幾個鼓件畫在同一條線上（`spike-report.md:287-301`），只刪一個會有歧義。
- **補充**：拍點上有音、但游標那條線上沒有音時，`Delete` 不動。
- **補充**：`deleteBeat` 之後，游標落在接替它位置的拍點上；沒有後面的拍點時，落在附加位置（錨點是新的最後一個拍點，聲線變空則沒有錨點）。

### 5.3 時值

| Command | 鍵 | 語意 |
|---|---|---|
| `durationStep` | `+` `-` | 時值變短／變長一級，保留附點（`commands.ts` 的 `durationStep`，由 `changeBeatAt`、`changeBeatsOnSelection` 套用；#22 刪掉了名字容易和它混淆的游標版 `stepDuration`）；到 64 分或全音符就不動 |
| `cycleDots` | `.` | 附點 0 → 1 → 2 → 0（補充） |
| `toggleTriplet` | `Shift+T` | 沒有連音時設成 `{ actual: 3, normal: 2 }`，有任何連音時移除（補充） |

有選取時，套用到選取範圍內的每個拍點（補充，規則同 5.4）。

- **補充**（#20）：和 5.4 一樣「一次決定、逐一套用」，寫法是 `commands.ts` 的 `BeatChange<D>`（`decide(seen)`、`turn(beat, decided)`），由 `changeBeatAt`（游標拍點）與 `changeBeatsOnSelection`（選取，沿用 `runsOf` 的走訪）套用，都是一個 Command，只寫入有改變的拍點。讀取時被略過的拍點不算、也不改。游標在附加位置時沒有拍點，不動。
  - `+`、`-`（`durationStep`）：每個拍點各自變短、變長一級；已經到 64 分或全音符的拍點不動。
  - `.`（`dotCycle`）：所有拍點都設成「範圍裡第一個拍點的附點」的下一個（0 → 1 → 2 → 0）。
  - `Shift+T`（`tripletToggle`）：所有拍點都已經有連音（任何一種）時，全部移除；否則全部設成三連音，原本是別種連音的拍點也一樣。
  - `Shift+R`（`clearNotes`）：見 5.6。

### 5.4 技巧與拍點記號

鍵見 [`keymap.md`](keymap.md)。每一次切換是一個 Command。

- **音符層級**（tie、legato、slideOut、slideIn、bend、vibrato、palmMute、letRing、dead、ghost、accent、staccato、harmonic、tap）作用在游標那條線上的音符；不適用於該聲部種類的鍵，不動。
- **拍點層級**（stroke、slap、pop、dynamic、三連音、清空）作用在游標拍點。
- 開關型的欄位：有就移除，沒有就設成 `true`。多值的欄位依序切換，最後回到「沒有」：
  - `slideOut`：`legato` → `shift` → `outUp` → `outDown` → 沒有。
  - `slideIn`：`inBelow` → `inAbove` → 沒有。
  - `bend.type`：`bend` → `bendRelease` → `preBend` → `preBendRelease` → 沒有；從沒有切到 `bend` 時 `semitones` 是 2（補充）。切換型時保留原本的 `semitones`。
  - `harmonic`：`natural` → `pinch` → `artificial` → 沒有。
  - `stroke`：`down` → `up` → 沒有。
  - slap／pop：slap → pop → 沒有（兩者互斥）。
  - `dynamic`：沒有 → `pp` → `p` → `mp` → `mf` → `f` → `ff` → 沒有。
- **bend 的半音數**（補充）：fretted 聲部按 `Shift+↑`／`Shift+↓`，把游標那條弦上的音符的 `bend.semitones` 加減 1，夾在 1–4；音符沒有 bend 時不動。
- **dead note**（`Shift+X`）：在有音的弦上切換 `dead`，保留格號。**補充**：在沒有音的弦上，建立一個沒有格號的 dead note `{ dead: true }`。
  - **補充**（#26）：在附加位置上，`Shift+X` 和輸入格號一樣建立新拍點，放上 dead note，游標移到新拍點；其他技巧鍵在附加位置不動（那裡沒有音）。
  - **補充**（#26）：在沒有格號的 dead note 上關掉 `dead`，移除這個音符，回到原本沒有音的弦。理由：fretted 音符要有 `fret` 或 `dead`（[`schema.md`](schema.md) 第 8 節），只拿掉 `dead` 會留下讀不懂的音符；這樣在既有的拍點上，`Shift+X` 按兩次也回到原狀。在附加位置上，第一次建立的拍點留下來，第二次只移除音符，留下一個休止拍點；要整個回到原狀用復原。
- **tie**（`Shift+L`）：「加上 tie」會把格號設成前一個音的格號。這是指令本身的效果，不是自動修復。
  - fretted：同一條聲線的前一個拍點（可以在上一小節）在同一條弦上有音時，把游標那條弦的音設成 `{ ...原值, fret: 前一個音的格號, tie: true }`；那條弦原本沒有音也一樣建立（只在游標上：有選取時不建立音符，見下面「有選取時」）。前一個拍點那條弦沒有音時：游標那條弦有音就只設 `tie: true`（之後會被標成 `danglingTie`），沒有音就不動（補充）。
  - pitched（補充）：游標那條線上有音時設 `tie: true`；那條線上沒有音、而前一個拍點同一條線上有音時，建立同一個音高、畫在游標那條線上的音並設 `tie: true`（#182：需要時寫入 `spell`；游標拍點上已經有同一個音高、畫在別條線的音時，那個音不算也不改，見下面 #49、#182 的補充）。
  - 已經有 tie 時，再按一次移除 `tie`，格號不變。
  - **補充**（#36）：寫法是 `commands.ts` 的 `tieToggle`（`NoteToggle<boolean>`）。`decide`：游標那條線上沒有音時是「加上」（才能建立音），否則「不是全部都有 tie 就加上，否則移除」，選取時一樣。`turn` 用 `place.before`：前一個音有格號時設成 `{ ...原值, fret: 前一個音的格號, tie: true }`（已經是同一個格號的 tie 就不寫入）；前一個音沒有格號（沒有音，或沒有格號的 dead note）時，有音就只設 `tie: true`，沒有音就不動，不會建立既沒有格號、也不是 dead 的音。pitched 的建立帶 `place.spell`（#182 改寫，原本只帶前一個音的 `spell`）：前一個音的 `spell`，前一個音沒有 `spell` 時不帶；只有不這樣寫就不會畫在游標那條線上時，才改寫成前一個音在它自己小節被畫出的拼法（見下面 #182 的補充）。在附加位置上和 dead note 一樣建立新拍點，游標移到新拍點。
  - **補充**（#49）：五線譜的 `Shift+L` 綁在 pitched 情境（[`keymap.md`](keymap.md) 第 3 節）。鍵由 `commands.ts` 的 `tieKeysAt(doc, cursor)` 給出，`EditorSession` 照樣以 `toggleKeysAt` 套用（一個 Command）：游標那條線上有音時是 `noteKeysAt` 的鍵（畫在那條線上的所有音，各自設 `tie`）；那條線上沒有音（或在附加位置上）時，是「前一個拍點」（同一條聲線、讀得懂的拍點，第一個拍點時是上一小節同一條聲線的最後一個）畫在游標那條線上的所有音的鍵，依游標譜表的譜號，以及**那個拍點所在小節**生效的調號算線（同 5.8 的 `noteKeysAt`）。`tieToggle` 在這些鍵上建立同音高、畫在游標那條線上的音並設 `tie`，所以 D 與 D♯ 同在一條線上時兩個都接上。前一個拍點在那條線上沒有音時不動，沒有交易。有選取時照樣是 `toggleOnSelection`，不建立音符。
  - **補充**（#182）：`Shift+L` 在空的線上只動畫在游標那條線上的音。(1) pitched 的鍵就是音高，同一個拍點不能有兩個同鍵的音：前一個拍點畫在游標那條線上的音，其鍵在游標拍點已經有音時（那個音依它的拼寫畫在別條線，例如前一拍是 D♯、這一拍是 E♭），`tieKeysAt` 把這個鍵排除，那個音不算也不改；排除後沒有鍵就不動，沒有交易。(2) 建立的音以**游標小節**的調號算 `lineOfPitch`，一定等於游標的 `line`：`toggleKeysAt` 在 pitched 聲部的游標上給 `place.spell`（`commands.ts` 的 `spellCarried`）。前一個拍點在同一小節，或兩個小節的調號把這個音畫成同一個拼法（`pitch.ts` 的 `spellCarriedTo`）時，就是前一個音的 `spell`（沒有就不帶，建立的音仍是 `{ tie: true }`）；否則是前一個音在它自己小節被畫出的拼法（F 大調沒有 `spell` 的 `n70` 接到 C 大調的小節時寫 `"Bb"`，不寫會被畫成 A♯）。這樣再按一次，同一條線上找得到這個音，只移除 `tie`。有選取時不給 `place.spell`（選取不建立音符）。
- **有選取時**（補充）：音符層級的切換作用在選取範圍內、目前聲部的**每一個**音符；拍點層級的切換作用在每一個拍點。全部都已經有該值時移除，否則全部設上。是一個 Command。
  - **補充**（#26）：拍點範圍是範圍內的拍點；小節範圍是目前聲部在那些小節裡所有聲線的拍點。**補充**（#20）：「所有聲線」是讀取時讀得到的聲線，依 `voiceKeys` 的順序（`commands.ts` 的 `runsOf`；#22 起和讀取共用 `schema.ts` 的 `readableVoicesOf`、`readableVoicesIn`）：聲部沒有的譜表上的聲線（例如單一譜表的吉他存著 `"5:0"`）、或存成別的形狀的聲線，不算也不改；`Delete`、技巧與時值鍵都一樣。選取裡只有休止時不動。選取時不建立音符：`Shift+X` 只切換已經有的音，沒有格號的 dead note 在關掉時移除（同上）。選取在切換之後保留，和 `Delete` 一樣。
  - **補充**（#26）：寫法在 `packages/score-model` 的 `commands.ts`。一個音符層級的技巧是一個 `NoteToggle<D>`：
    - `decide(seen)` 從看得到的音符一次決定目標狀態 `D`。游標上，`seen` 是那條線上的音（線上沒有音時是空的）；有選取時，是範圍內所有的音。所以循環型的技巧（slideOut、slideIn、bend 的型、harmonic）在選取上全部走到同一個狀態，不是各自走到自己的下一個。
    - `turn(stored, decided, place)` 把每個音符轉成那個狀態。`stored` 是儲存的原值（補充，#103：它自己的欄位的複本，見 [`schema.md`](schema.md) 第 9 節），沒有音時是 `undefined`。回傳 `null` 表示那裡沒有音（有就移除）；回傳 `stored` 本身表示不變，不寫入。`place` 帶著聲部種類（`kind`，補充，#36：tie 在 pitched 才建立同音高的音）、音符鍵，以及同一條聲線前一個拍點上同一個鍵的音（讀得懂時才有）；第一個拍點的前一個拍點，是上一小節同一條聲線的最後一個拍點。前一個拍點也在選取裡時，給的是它這次轉成的結果（被移除時是沒有音），所以 tie 套在連續幾個拍點上，全部取到第一個音的格號；小節範圍裡，結果也依序帶到下一小節的第一個拍點。tie 用它取前一個音的格號。
    - `toggleAt(doc, cursor, key, toggle)` 作用在游標拍點上 `key` 的音；`toggleKeysAt(doc, cursor, keys, toggle)` 作用在好幾個鍵上，`decide` 看所有這些音、一次決定，是一個 Command。鍵由 `noteKeysAt` 給出（補充，#44：fretted 是那條弦；鼓是游標拍點上畫在那條線上的所有鼓件，附加位置上沒有；補充，#48：五線譜是游標拍點上畫在那條線上的所有音，附加位置上沒有，見 5.8 的補充；#49 起五線譜綁上 tie、accent、staccato，tie 的鍵另見上面 #49 的補充）。在附加位置上，`toggle` 建立的音放在新拍點上，`place.before` 是錨點拍點的音。`toggleOnSelection` 作用在選取，不建立音符。兩者都是一個 Command，只寫入有改變的音。
    - 開關型的技巧（`ON_OFF_TECHNIQUES`）由 `techniqueToggle` 給出：`onOffToggle` 的 `decide` 是「不是全部都有」，只改已經有的音；dead 是 `deadToggle`（上面兩條補充）。
    - 讀取時被略過的拍點與音符（[`schema.md`](schema.md) 第 11 節，`read.ts` 的 `readsAsBeat`、`schema.ts` 的 `readNote`）不算進 `seen`，也不改：選取時如此，游標那條線上的音讀不懂時，技巧鍵也不動它。找前一個拍點時，也跳過讀不懂的拍點，和成員看到的一樣。
    - 限制：`place.before` 只找同一個鍵的音。fretted 的 tie 這樣就夠（鍵就是弦）；pitched 的 tie 依「同一條線」找前一個音，那個音可能是另一個音高的鍵：#49 由 `tieKeysAt` 先找出前一個拍點畫在那條線上的音的鍵，`place.before` 再取同一個鍵的音（見上面 #49 的補充）。
    - 拍點層級的欄位（stroke、slap／pop、dynamic、text）不是音符，不用 `NoteToggle`。
  - **補充**（#27）：legato（`Shift+H`）是開關型的技巧，在 `ON_OFF_TECHNIQUES` 裡，只改已經有的音。`slideOut`（`Shift+S`）與 `slideIn`（`Shift+E`）是 `slideOutCycle`、`slideInCycle`（`NoteToggle`，順序是 `schema.ts` 的 `SLIDE_OUTS`、`SLIDE_INS`）：`decide` 是「看到的第一個音的值」的下一個，和拍點記號的 `markingCycle`、`.` 的附點同一個規則，所以選取上全部走到同一個狀態；`turn` 只改已經有的音，不建立音符，其他欄位保留，已經是那個值時不寫入。三者都不檢查有沒有「下一個音」：沒有時照樣寫入，之後被標成 `danglingLink`（[`flags.md`](flags.md)）。
  - **補充**（#28）：`Shift+B` 是 `bendCycle`（`NoteToggle`，順序是 `schema.ts` 的 `BEND_TYPES`）：`decide` 和 slide 一樣是「看到的第一個音的型」的下一個；`turn` 只改已經有的音，不建立音符，其他欄位保留。從沒有切到一個型時是 2 個半音（`BEND_SEMITONES.initial`）；已經有 bend 的音換型時保留它自己的 `semitones`，所以選取上全部走到同一個型，半音數各自保留。`Shift+↑`／`Shift+↓` 是 `bendStep(1)`、`bendStep(-1)`（`NoteToggle<void>`，和 `durationStep` 一樣每個音各自加減）：沒有 bend 的音、已經到 1 或 4 的音不寫入，所以也沒有復原步驟。有選取時兩者都作用在範圍裡每一個音。
  - **補充**（#29）：`Shift+N` 是 `harmonicCycle`（`NoteToggle`，和 slide 一樣由 `noteCycle` 做出，順序是 `schema.ts` 的 `HARMONICS`）：`decide` 是「看到的第一個音的值」的下一個，所以選取上全部走到同一個泛音；`turn` 只改已經有的音，不建立音符，其他欄位保留，已經是那個值時不寫入。任何格號都可以設，包括沒有節點的格（聲音見 [`schema.md`](schema.md) 第 8 節的補充）。
  - **補充**（#27，#26 留下的）：游標停在讀取時被略過的拍點上時，`toggleAt` 不動，即使那個拍點的音符本身讀得懂。拍點範圍的選取，聲線不是那個聲部有的（`isVoiceKey`）時，和小節範圍一樣不算也不改。
  - **補充**（#30）：拍點記號沿用 5.3 的 `BeatChange<D>`（`changeBeatAt`、`changeBeatsOnSelection`，選取時走 `runsOf` 與 `selectedBeatsOf`），不另開一條選取的路。`decide` 看到的拍點（`SeenBeat`）多了 `markings`（`BeatMarkings`，`CONTEXT.md` 的 Beat marking；不叫 flag，因為 Flag 不存在團譜裡）：讀取時讀出的 stroke、slap、pop、dynamic、text（`read.ts` 的 `readBeatFields`，同時有 slap 與 pop 時讀成只有 slap）；`turn` 回傳的 `BeatWrite` 多了 `set`：值是寫入，`null` 是移除。
    - 三個循環型的記號，選取時全部設成「範圍裡第一個拍點的值」的下一個，和 `.` 的附點一樣：`strokeCycle`（down → up → 沒有）、`slapPopCycle`（slap → pop → 沒有；切到 pop 時同一筆交易移除 slap，所以兩人同時寫成兩者都有的拍點，按一次就只剩 pop）、`dynamicCycle`（沒有 → pp → … → ff → 沒有）。
    - 休止拍點也照樣設上（拍點層級的切換作用在每一個拍點）；讀不懂的拍點不算、也不改；寫入時以儲存的原值為底，不認得的欄位保留。
    - 寫入不適用於該聲部種類的欄位（stroke、slap、pop 在鼓與五線譜）時整個不動，不寫入：寫了，讀取時整個拍點會被略過（`schema.ts` 的 `beatFieldFits`）。鍵本身也只綁在 fretted（[`keymap.md`](keymap.md) 第 3 節的補充）。

### 5.5 文字與歌詞

- `setText`：在游標拍點開內嵌輸入框，`Enter` 存入；空字串表示移除。一次存入是一個 Command。
  - **補充**（#30）：`commands.ts` 的 `setText(doc, cursor, text)`，以 `beatText` 這個 `BeatChange` 套用在游標拍點；超過 64 字元（`MAX_BEAT_TEXT`）時回傳 false、不寫入；和原本相同時不寫入。附加位置沒有拍點，不動。不修剪空白，照原樣存。
  - **補充**（#30）：開框與存入分在兩邊。`EditorSession` 處理 `Enter`：游標在讀得懂的拍點上時，以 `onEditText` 送出 `{ cursor, text }`（`textAt`：現有的文字，沒有時是空字串）；附加位置不送。唯讀時 `Enter` 和其他會改動文件的鍵一樣被拒絕。殼開框，`Enter` 時呼叫 `EditorSession.setText(cursor, text)`：存在開框時的 `cursor` 那個拍點上（拍點已被刪除就不動），選取結束。開框本身不改動文件，選取不變；`Esc` 或焦點離開輸入框時不存，選取也不變。
- `setLyric`（只有 pitched）：歌詞模式，見 [`keymap.md`](keymap.md)。每存一個音節是一個 Command。空字串表示延長；音節結尾的 `-` 表示字還沒結束。
  - **補充**（#50）：`commands.ts` 的 `setLyric(doc, cursor, lyric)`，以 `beatLyric` 這個 `BeatChange` 套用在游標拍點（`BeatMarkings` 多了 `lyric`）：字串照原樣存（空字串是延長），`null` 移除歌詞；超過 32 字元（`MAX_LYRIC`）時回傳 false、不寫入；和原本相同時不寫入（空字串和沒有不算相同）。附加位置、非 pitched 聲部的拍點都不寫入（`beatFieldFits`）。歌詞模式的拍點移動是 `sungBeatFrom(doc, cursor, "here" | "next")`：同一聲線、可以跨小節的下一個非休止拍點，沒有時是 null。開框與按鍵的分工見 [`keymap.md`](keymap.md) 6.2 的補充。
- 段落名稱（`section`）從小節屬性面板編輯，是結構操作（第 6 節）。

### 5.6 清空、複製、剪下、貼上

| Command | 沒有選取 | 拍點範圍 | 小節範圍 |
|---|---|---|---|
| `Delete` | 見 5.2 | **補充**：範圍內的拍點變成休止（移除音符，保留時值與其他拍點欄位）；範圍內全部已經是休止時，刪除這些拍點 | 清空目前聲部在這些小節裡的所有聲線（變成空的聲線，也就是整小節休止）；補充（#21）：在原本的聲線上刪除，不換掉聲線，同 5.7 第 3 點 |
| `Shift+R` | 清空游標拍點的音符，成為休止（補充：只移除 `notes`，其他拍點欄位保留） | 同左，作用在範圍內每個拍點；和 `Delete` 不同，全部是休止時也不刪除拍點（補充，#20） | 同左，目前聲部在這些小節裡所有聲線的拍點（補充，#20：`clearNotes`，見 5.3） |
| 複製 | 不動 | 拍點段 | 小節段 |
| 剪下 | 不動 | 複製加上「清空」 | 複製加上「清空」 |
| 貼上 | 依剪貼簿的片段種類 | 同左 | 同左 |

- 剪下等於「複製加上一個清空的 Command」，所以是一個復原步驟。Viewer 只能複製，不能剪下或貼上。
- **貼上小節段**：語意和放置（5.7）相同，是取代；目標是游標所在的聲部與小節，套用 5.7 的所有規則。
- **貼上拍點段**：插入到游標所在的聲線，插在游標拍點之前，或在附加位置上附加。種類必須相同；fretted 片段用到的弦超過目標聲部的弦數時拒絕。貼上的拍點產生新的 id。游標移到最後一個貼上的拍點。
- 剪貼簿的格式與實作見 [`phrases.md`](phrases.md)。
- **補充**（#58）：寫法在 `packages/score-model` 的 `clipboard.ts`（`clipboardText`、`fragmentOfClipboard`、`fragmentOfSelection`）與 `drop.ts` 的 `pasteBeats`（插入的位置同 `insertBeat`，`commands.ts` 的 `placeFor`），測試在 `packages/score-model/tests/clipboard.test.ts`；`EditorSession` 的 `copy()`、`cut()`、`paste(text)`（`packages/score-editor/tests/clipboard.test.ts`）。
  - 剪下的「清空」就是 `Delete` 對選取做的事（`deleteSelection`）：拍點範圍裡有音的拍點變成休止，範圍內全部已經是休止時刪除這些拍點；小節範圍清空那些小節的所有聲線。複製不改動文件，所以剪下是一筆交易、一個復原步驟；選取和 `Delete` 一樣保留。
  - 貼上小節段：目標是 `{ partId: 游標的聲部, barId: 游標的小節 }`，走 `EditorSession.drop`（#57），和側欄的放置是同一條路：游標停在原處（拍點被取代時移到那裡最近的位置）。貼上拍點段：只插進讀取讀得到的聲線（`readableVoicesOf`）；fretted 調弦不同時同樣提示「調弦不同」（同 5.7 第 6 點），調弦讀不懂時不檢查弦數（同 5.7 的 host 裁定）。兩者之後選取結束；被拒絕時文件不動、游標與選取不變。
  - 唯讀（Viewer）：`copy` 照常；`cut`、`paste` 被拒絕，和其他會改動文件的鍵一樣只提示一次「檢視者無法修改」（`onRefused`），不寫入剪貼簿（`Ctrl+X` 不會蓋掉先前複製的內容），文件不動。
  - 提示：拒絕的原因與 5.7 的 `hints` 依 `strings.ts` 的 `score.clipboard` 顯示（`hints` 和側欄的放置共用同一組文字）；同時有兩個 `hints`（調弦不同、附加小節）時用「；」接起來一次顯示。游標所在的小節已經不在（`gone`）時提示「游標所在的小節已經不在了」。

### 5.7 放置（Drop）

把一個小節段（樂句或剪貼簿）放進目標聲部，從目標小節起取代 N 個小節。

1. 只能放進同一種 kind 的聲部。
2. 以片段的 N 個小節內容，覆寫目標聲部從目標小節起的 N 個小節；所有聲線都覆寫。目標聲部有、片段沒有的聲線，清空。
3. **怎麼覆寫**：在既有每條聲線的 `Y.Array` 上先刪再插，不要整個換掉小節內容的 `Y.Map`。同時在那裡輸入的人，拍點會保留下來（之後被標成 overfull），不會無聲消失（ADR 0002 增補）。
4. 團譜的小節不夠時，在譜尾附加小節。這是結構變更，所有聲部都會多出小節。**補充**：附加的小節照 `insertBars` 的規則沿用前一個小節的拍號，不用片段的拍號；附加後總數不得超過 1000，超過就拒絕整個放置。
5. 拍號以團譜為準；不合就標 Flag，不改寫。
6. fretted 的調弦不同時，照抄格號，並提示「調弦不同，格號照原樣放入」。
7. 片段用到的弦（有音的最大弦號）超過目標聲部的弦數時，拒絕。
8. pitched：片段用到目標聲部沒有的譜表時，拒絕；目標聲部有、片段沒有的譜表，清空。
9. 放進來的拍點一律產生新的 id。
10. 整個動作是一筆交易、一個復原步驟。
11. 不跳對話框；用提示加上 Flag 告知。

- **補充**（#56）：寫法在 `packages/score-model` 的 `drop.ts`，測試在 `packages/score-model/tests/drop.test.ts`。
  - `dropFragment(doc, { partId, barId }, fragment)`：目標是聲部與小節，不是游標（拖曳的目標由 `hitTest` 給出，可以不是游標所在的聲部）；游標由殼或 `EditorSession` 之後用 `settleCursor` 處理。成功時回傳 `Dropped`：`barIds`（寫入的小節，依順序，附加的在最後）與 `hints`（`DropHint`：`"tuningDiffers"`、`"barsAppended"`），殼依 `hints` 顯示提示。
  - 拒絕時回傳 `DropRefusal`，文件不動、不開交易：`"gone"`（聲部或小節不在，或聲部讀不懂）、`"otherKind"`（第 1 點）、`"tooManyStrings"`（第 7 點）、`"otherStaves"`（第 8 點）、`"tooManyBars"`（第 4 點）、`"invalid"`（片段不合 `barsFragmentSchema`：指令自己再驗一次，所以不合 schema 的值不會進文件）。
  - 「用到的譜表」是有拍點（休止也算）的聲線所在的最後一個譜表；片段帶了目標沒有的譜表、但那些聲線是空的，照樣接受。「用到的弦」同第 7 點，只看有音的弦，所以 6 弦的片段只用到第 1–4 弦時可以放進 4 弦貝斯（照樣提示調弦不同）。
  - 調弦「不同」：目標聲部的 `tuning` 讀不懂、弦數不同或任一條弦不同。`tuning` 讀不懂時不知道有幾條弦，所以略過第 7 點的弦數檢查，照樣放入並提示調弦不同（host 裁定，#56 審查）。
  - 覆寫的聲線是 `readableVoicesOf` 讀得到的那些；文件裡缺少的聲線容器不在這裡建立（第 9 節：只有伺服器補），片段在那條聲線的拍點不寫入。
  - 附加小節用 `insertBars`，與覆寫在同一筆交易裡（Yjs 的巢狀 `transact` 併入外層），所以整個放置、包含附加的小節，是一個復原步驟。
  - 片段裡不認得的欄位在驗證時已經去掉（[`phrases.md`](phrases.md) 1.1），寫進文件的是驗證後的值，再經 `writableCopy`（#102：沒有 `__proto__`、不超過 `MAX_VALUE_DEPTH`）。放置不改寫既有的值（先刪再插新的拍點），所以不經 `ownFields`（#103）。
  - 兩位成員同時放置在同一個小節：兩邊都刪掉自己看到的拍點、插入自己的片段，合併後兩段片段都在、各自連在一起，小節標成 overfull（第 3 點）。
  - 附加的小節已改用 `keysOfARun` 的排序鍵（#58，`insertBars` 插入或附加的小節都是一串自己的鍵，放在前後兩個小節的鍵之間），讓兩人同時在譜尾附加的兩串小節不交錯（`packages/score-model/tests/drop.test.ts`）。

### 5.8 Pitched 的升降與八度

- `]`／`[`：把游標那條線上的音升高／降低半音。做法是重設音符鍵（例如 `n60` 改成 `n61`），保留其他欄位，算一個 Command。**補充**：結果是黑鍵時，`]` 拼成升、`[` 拼成降；結果是白鍵時拼成本位。`line` 跟著音移到它新的譜表位置。
- `Shift+↑`／`Shift+↓`：把游標那條線上的音移一個八度（鍵 ±12），保留拼寫；`line` 跟著移 7 格。超出 0–127 時不動。
- 一條線上同時有好幾個音（例如 D 與 D♯）時，作用在那條線上的每一個音（補充）。
- **補充**（#48）：寫法是 `commands.ts` 的 `moveNotesBySemitone(doc, cursor, 1 | -1)`（`]`、`[`，鍵是 `bindings.ts` 的 `sharpen`、`flatten`）與 `moveNotesByOctave(doc, cursor, 1 | -1)`（`Shift+↑`、`Shift+↓`，`octaveUp`、`octaveDown`，綁在 pitched 情境；fretted 的同一組鍵仍是 bend 的半音數）。
  - 「畫在那條線上的音」是 `noteKeysAt`：游標拍點上每個讀得懂的音，依譜號與它的拼寫（`spell` 和音高相符時用它，否則用調號的預設拼寫，[`schema.md`](schema.md) 8.1 的補充）算出的譜表位置等於 `line` 的那些。所以 C 與 C♯ 在同一條線，D♭ 在 D 的線；B♯3（音高同 C4）畫在 B3 的位置。讀不懂的音不畫，不在任何一條線上；讀不懂的拍點、附加位置都沒有。
  - 改寫以原值的自有欄位（`ownFields`）為底，只換音符鍵與（`]`、`[` 時的）`spell`；八度保留原本的 `spell`，原本沒有 `spell` 的照樣沒有。一筆交易：先刪掉所有被移動的鍵，再寫入新鍵（D 與 D♯ 一起升半音時，D♯ 變 E、D 變 D♯，不會互相蓋掉）。新鍵上已經有拍點上別的音（例如 E 與 F 同在、E 升半音）：被移動的音取代它，後輸入的贏，同 5.1。值經 `writableCopy`（#102），超過深度上限時整個不寫入。
  - 任一個音會超出 0–127 時，整個不動（不只略過那一個）。那條線上沒有音時不動，沒有交易。
  - 游標跟著移動後**最低**的那個音，到它的譜表位置，夾在 −4..12 裡：一條線上的音移動後可能分到兩條線（D 與 D♯ 升半音後是 D♯ 與 E），取最低的音，讓連按 `]` 時游標留在原本那個音上。八度一律是 ±7 格（同一個拼寫），超出範圍時停在 −4 或 12。
  - 有選取時，`]`、`[`、`Shift+↑`、`Shift+↓` 和 `A`–`G` 一樣不作用在選取上：作用在游標那條線上，之後選取結束（第 4 節「其他不作用在選取上的 Command」）。
  - 測試：`packages/score-model/tests/pitch.test.ts`（純函式，含 fast-check）、`staff.test.ts`；`packages/score-editor/tests/staff.test.ts`（按鍵與復原步驟）；`packages/score-render/tests/spelling.test.ts`（畫出來的位置等於 `lineOfPitch`）。

## 6. 結構操作

每一項都是一個 Command、一個復原步驟，作用於整份團譜的小節。

| Command | 鍵或介面 | 語意 |
|---|---|---|
| `insertBars` | `Ctrl+Insert`：在游標小節**之前**插入 1 個空小節。`Ctrl+Shift+Insert`（補充）：在游標小節**之後**插入。譜尾的「＋小節」按鈕：附加 1 個 | 新小節沿用前一個小節的拍號；插在最前面時沿用後一個小節的拍號（現在就是這樣，`commands.ts` 的 `insertBars`）。只寫 `timeSig`，不複製速度、調號等變化點。同一筆交易裡替所有聲部建好容器。游標移到新小節的第一個位置（補充） |
| `deleteBars` | `Ctrl+Delete`：有小節範圍時刪除範圍，否則刪除游標小節 | 不跳確認對話框，可以復原。至少留下 1 個小節（補充）。同時送到的輸入會消失，見第 9 節 |
| `setTimeSig` | 小節屬性面板 | 有小節範圍時，作用在那個範圍；沒有時，從游標所在小節起，到下一個拍號和原值不同的小節為止 |
| `setTempo` | 小節屬性面板 | 只寫在游標所在的小節；「清除」就是移除這個變化點 |
| `setKeySig` | 小節屬性面板 | 同上 |
| `setSection` | 小節屬性面板 | 同上；1–64 字元 |
| `setRepeat` | 小節屬性面板 | `repeatStart` 寫在範圍的第一個小節，`repeatEnd`（總共演奏幾次，2–32）寫在最後一個小節；沒有範圍時，游標小節同時是第一個與最後一個（補充）。面板可以分別清除兩者 |
| `setVoltas` | 小節屬性面板 | `voltas` 寫在範圍內的每個小節；空陣列表示清除 |
| `toggleAnacrusis` | 小節屬性面板 | 只能在第一小節切換 |

- 範圍：結構操作讀選取時，拍點範圍當成它所在的那一個小節（補充）。
- **補充**（#22）：寫法在 `packages/score-model` 的 `commands.ts`，測試在 `packages/score-model/tests/bars.test.ts`、`packages/score-editor/tests/bars.test.ts`。
  - 選取的範圍由 `structuralRange(doc, selection)` 給出：小節範圍是它的小節，拍點範圍是它的那一個小節，沒有選取是 null（由各指令決定）。
  - `insertBars` 讀相鄰小節的拍號經過 `parsePlain`，讀不懂就用 4/4；`after` 指的小節不在、或插入後超過 1000 個小節（`MAX_BARS`，`ordered` 讀得到的小節數）時不做事、回傳空陣列。插在最前面時，同一筆交易移除原第一小節的 `anacrusis`（[`schema.md`](schema.md) 第 3 節）。
  - `insertBarAt(doc, cursor, "before" | "after")`、`appendBar(doc, cursor)`（「＋小節」）：插入 1 個小節，游標移到新小節裡**自己那條聲線**的第一個位置（新小節是空的，所以是附加位置），`line` 不變。游標的小節不在時不動。已經 1000 個小節時回傳 `"tooManyBars"`（`BarRefusal`），`EditorSession` 以 `onHint` 告訴成員（`strings.ts` 的 `score.hints.tooManyBars`）。
  - `deleteBarsAt(doc, cursor, selection)`：刪除 `structuralRange` 的小節，沒有選取時是游標小節；在同一筆交易裡刪除 `bars` 的項目與每個聲部 `content` 裡那些小節的內容。游標移到刪除範圍之後那個小節裡自己那條聲線的第一個位置，範圍在譜尾時移到它之前的小節。範圍包含所有小節時整個拒絕，回傳 `"lastBar"`（提示「至少要留下一個小節」），不是只留下一個。刪除之後選取結束；被拒絕時選取不變。
  - `setTimeSig(doc, cursor, selection, timeSig)`：沒有選取時，「原值」是游標小節讀到的拍號（讀不懂當成 4/4），範圍一直到第一個讀到的拍號和原值不同的小節之前（之後又出現同樣的拍號也不算）。只寫入讀到的值不同、或讀不懂的小節；拍號不合 [`schema.md`](schema.md) 第 3 節的範圍時回傳 false、不寫入。選取在之後保留。
  - `setTempo(doc, cursor, tempo | null)`：20–400 以外（含 `NaN`、無限大）回傳 false；和原值相同、或清除一個沒有的變化點時不寫入。選取在之後保留。
  - 一個小節「生效的速度」是 `schema.ts` 的 `tempoAt(score, barId)`：到它為止最後一個寫著 `tempo` 的小節的值，沒有時是 `DEFAULT_TEMPO`（120，`score-render` 的投影也用它）。
  - `EditorSession` 的按鍵是 `insertBarBefore`、`insertBarAfter`、`deleteBars`（[`keymap.md`](keymap.md) 第 2 節）；工具列與面板不經按鍵，呼叫 `insertBar(side)`、`appendBar()`、`deleteBars()`、`setTimeSig(timeSig)`、`setTempo(tempo)`。它們和按鍵走同一條路：唯讀時拒絕並提示一次，各是一個復原步驟（第 8 節），也結束兩位數格號的等待。
  - 小節屬性面板（#22 先做拍號與速度，其餘欄位在 #23 加上）：`apps/web/src/components/BarPanel.vue`，只在可編輯視圖。標題是游標小節，有選取時是選取的小節；拍號與速度各有「套用」，`Enter` 在欄位裡就是套用；速度欄留空並套用、或按「清除速度」，就是移除這個變化點。開關的鍵與焦點見 [`keymap.md`](keymap.md) 第 5 節。
  - **補充**（#23）：其餘欄位的指令也在 `commands.ts`，測試在同兩個 `bars.test.ts`。每一個是一筆交易、一個復原步驟；讀到的值和要寫的相同（經 `parsePlain`）時不寫入，讀不懂的值照樣覆寫；游標的小節不在時回傳 false、不寫入。選取在之後保留。
    - `setKeySig(doc, cursor, keySig | null)`：只寫在游標小節，`null` 移除；不合 `keySigSchema` 時回傳 false。一個小節「生效的調號」是 `schema.ts` 的 `keySigAt(score, barId)`（逐小節是 `keySigsOf(bars)`），沒有時是 `DEFAULT_KEY_SIG`（C 大調）。
    - `setSection(doc, cursor, section | null)`：只寫在游標小節，`null` 移除；不是 1–64 字元（含空字串）時回傳 false。面板先去掉前後空白，留空並套用就是清除。
    - `setRepeat(doc, cursor, selection, change)`：`change` 是 `{ times }` 或 `{ clear: "start" | "end" }`（`RepeatChange`）。範圍是 `structuralRange` 裡還在的小節，沒有選取時是游標小節。`{ times }`（2–32 的整數，否則回傳 false）在同一筆交易裡把 `repeatStart` 寫在範圍的第一個小節、`repeatEnd` 寫在最後一個小節；`clear: "start"` 從第一個小節移除 `repeatStart`，`clear: "end"` 從最後一個小節移除 `repeatEnd`。範圍內外其他小節的反覆記號都不動。
    - `setVoltas(doc, cursor, selection, passes)`：同一個範圍裡每個小節都寫成 `passes`（各自一份陣列），空陣列移除；不是 1–8、遞增、不重複時回傳 false。
    - `toggleAnacrusis(doc, cursor)`：游標小節是 `ordered` 的第一個小節時切換，否則回傳 false、不寫入；讀不懂的 `anacrusis` 當成沒有，切換後是 `true`。
    - `EditorSession` 的 `setKeySig`、`setSection`、`setRepeat`、`setVoltas`、`toggleAnacrusis`，和 `setTempo` 走同一條路。
    - 面板：調號是「大小調」與「調」兩個下拉選單（15 個調，以 `strings.score.bars.keyName` 顯示，例如「B♭ 大調（2 個降記號）」），沒有變化時顯示沿用的調；段落名稱一個欄位；反覆是「總共演奏幾次」與「設定反覆」「清除反覆開始」「清除反覆結束」，並顯示反覆會寫在哪些小節、範圍兩端現有的反覆記號；跳房子是 1–8 的勾選框，寫在選取的每個小節或游標小節；勾選的遍數超過對應反覆的總次數時（那一遍永遠不會演奏，例如反覆 2 次的第 3 遍），面板顯示提示（`strings.score.bars.voltasUnplayed`，`data-voltas-unplayed`），照樣可以套用，不改文件、不標 Flag。「對應的反覆」是 `schema.ts` 的 `voltaRepeatTimes(score, barIds)`：這些小節連同前後相連、帶 `voltas` 的小節裡第一個 `repeatEnd`，沒有時看緊接在它們之前的小節，都沒有時是 1；弱起只在游標是第一小節時出現，是一個勾選框。e2e 掛點：各組 `data-panel-key-sig`、`data-panel-section`、`data-panel-repeat`、`data-panel-voltas`、`data-panel-anacrusis`。
    - **共編**（#23）：這些欄位各自是小節 `Y.Map` 的一個值，兩位成員同時寫同一個小節的同一個欄位時，結果是其中一個值（Yjs 的 last-writer-wins），兩邊相同而且合法，不標 Flag。兩人同時在不同小節設反覆，可能留下不成對、重疊或巢狀的反覆開始與結束：每個欄位本身都合法，所以不拒絕也不標 Flag（[`flags.md`](flags.md) 沒有這一類），照常顯示，聲音照 alphaTab 的反覆規則播放、不丟例外；成員從面板自行清除。一人把第一小節設成弱起、另一人同時在它前面插入小節時，`anacrusis` 留在已經不是第一的小節上，讀取時忽略（[`schema.md`](schema.md) 第 3 節），新的第一小節可以再設。測試：`packages/score-model/tests/bars.test.ts` 的兩份 `Y.Doc` 測試、`packages/score-render/tests/sound.test.ts`。
  - 「看得出影響所有聲部」：小節範圍、以及面板開著時的游標小節（有拍點範圍時是它的小節），在疊層上畫虛線框，每一行譜一個，橫跨所有顯示中的聲部（`ScoreRenderer.boundsOfBars`、`geometry.ts` 的 `barRangeRects`；選哪些小節是 `apps/web/src/overlay.ts` 的 `structuralEnds`，框是 `structureBoxesOf`，避開保留區域，線畫在框內）。小節範圍原本只蓋住自己聲部的選取框（第 4 節）照樣畫，因為 `Delete` 這類內容操作只作用在那個聲部。疊層裡每個虛線框是 `<rect data-structure>`。
- **小節屬性面板**：側邊面板，顯示並編輯游標所在小節的拍號、速度、調號、段落名稱、反覆開始、反覆次數、volta、弱起（只有第一小節顯示）。開啟的鍵見 [`keymap.md`](keymap.md)。
- 新增小節後總數不得超過 1000（補充）。
- 「＋小節」、「插入小節」、「刪除小節」在工具列也有按鈕（補充：很多筆電沒有 `Insert` 鍵）。**補充**（#22）：「插入小節」插在游標小節之前（同 `Ctrl+Insert`）；「＋小節」在譜面最後、整份譜的下方。

## 7. 設定類的 Command

### 7.1 聲部管理

Editor 與 Owner 可以新增、刪除、重新排序聲部。

- **新增**（`addPart`）：從預設表（第 10 節）選一項。必須在同一筆交易裡替所有小節建好內容容器（ADR 0002:21，`commands.ts` 的 `addPart`）。名稱自動編號，例如已有「吉他 1」時，新的是「吉他 2」。超過上限（總共 16 個、非鼓 15 個）時拒絕並提示。
- **刪除**（`deletePart`）：先跳確認對話框，列出有內容的小節數；可以復原。最後一個聲部不能刪（補充）。
- **排序**（`movePart`）：新增；修改 fractional index 排序鍵。
- 刪除聲部要確認、刪除小節不要確認，這個不對稱是刻意的：刪小節是常見的小動作，刪聲部會清掉整件樂器。
- **補充**：兩個人同時新增聲部可能讓總數超過上限。讀取時照常顯示；超出的非鼓聲部共用最後一個聲道（[`playback.md`](playback.md)）；「新增聲部」在超過上限時停用。

### 7.2 聲部屬性

| Command | 語意 |
|---|---|
| `setPartName` | 1–64 字元 |
| `setTuning` | 只有 fretted；整個陣列替換，弦數不可改；格號不變，所以音高跟著變。選項見第 10 節 |
| `setCapo` | 只有 fretted；0–24 |
| `setProgram` | 非鼓聲部；0–127 |
| `setClef` | 只有 pitched；改某個譜表的 clef（`staves` 整個替換），只影響顯示 |

### 7.3 團譜

- `setTitle`：1–100 字元。`setArtist`：0–100 字元，空字串表示移除。都可以共編、可以復原。
- **補充**（#24）：寫法與介面。
  - 指令在 `packages/score-model` 的 `commands.ts`：`addPartWithin`（`addPart` 加上限檢查；上限判定是 `canAddPart(doc, kind)`，讀不懂種類的聲部算成非鼓，所以不會比文件裡的聲部少算）、`deletePart`、`movePart(doc, partId, after)`（`after` 是 null 時放到最前面；只改這個聲部自己的 `order`，鍵由 `keysAfter` 產生；已經在那裡時不寫入）、`setPartName`、`setTuning`、`setCapo`、`setProgram`、`setClef(doc, partId, staff, clef)`、`setTitle`、`setArtist`。從預設表新增是 `presets.ts` 的 `addPresetPart(doc, preset, tuning?)`（名稱用 `partNames` 接在團譜既有名稱之後；`tuning` 的弦數要和預設相同，否則回傳 null）。拒絕的理由是 `PartRefusal`：`"tooManyParts"`、`"lastPart"`。值超出範圍、聲部不在、種類不合時回傳 false、不寫入；讀到的值和要寫的相同時不寫入。沒有改 `kind`、弦數、譜表數的指令；`setTuning` 拒絕不同的弦數，`setClef` 只接受 pitched 聲部（fretted 的 TAB 與鼓的譜表都不改）。`staves` 讀不懂時當成預設（一個高音譜表）再改。
  - 刪除確認對話框列出的「有內容的小節數」是 `barsWithContent(score, partId)`：那個聲部任一聲線有拍點（休止也算）的小節數。
  - `EditorSession` 的 `addPart(preset, tuning?)`、`deletePart`、`movePart`、`setPartName`、`setTuning`、`setCapo`、`setProgram`、`setClef`、`setTitle`、`setArtist` 不經按鍵、不需要游標（沒有游標時也能執行），各是一個復原步驟；唯讀時拒絕並提示一次；成功後選取結束。上限與最後一個聲部以 `onHint` 告訴成員（`strings.ts` 的 `score.hints.tooManyParts`、`lastPart`）。刪掉游標所在的聲部（自己或別人刪的）時，游標照第 2 節用 `startOfScore` 回到第一個聲部第一小節，`line` 用那個聲部上次的 `line`。
  - 介面：可編輯視圖的工具列有「聲部」按鈕，開關側邊的聲部面板（`apps/web/src/components/PartPanel.vue`，和小節屬性面板一次只開一個；`Esc` 以 `textEntryEffectOf` 的 `cancelEntry` 關閉）。面板列出聲部（拖動或「上移」「下移」排序）、新增聲部（預設表與 fretted 的調弦選項；到上限時停用並提示）、刪除（`AppConfirmDialog` 確認）、所選聲部的屬性（名稱、調弦含逐弦自訂、capo、program、pitched 各譜表的譜號）。標題列在可編輯視圖有「修改標題」按鈕，開一個表單同時改標題與演出者（`TitleEditor.vue`；`Enter` 套用、`Esc` 取消），有改動的欄位各自是一個 Command。讀到空的標題時顯示「未命名」（`strings.score.untitled`）。沒有新的快捷鍵。e2e 掛點：`data-toggle-parts`、`data-part-panel`、`data-part-row`（`data-part-id`）、`data-part-edit`、`data-part-delete`、`data-add-part`、`data-part-properties`、`data-part-tuning`、`data-edit-title`、`data-title-form`。
  - **共編**（#24）：兩人同時刪除同一個聲部，合併後聲部不在，兩份文件一致，其中一人復原就帶回聲部與刪除當下的內容。一人刪除聲部時另一人正在那個聲部打字或改屬性：那些修改跟著聲部消失（和刪除小節相同），復原帶回的是刪除當下的樣子；另一人的游標回到譜首。兩人同時改同一個屬性或標題：Yjs 的 last-writer-wins，結果是其中一個值，兩邊相同。兩人同時移動聲部：各自的 `order` 帶隨機後綴，順序兩邊一致。測試：`packages/score-model/tests/parts.test.ts`、`packages/score-editor/tests/parts.test.ts`。
  - **0 個聲部**（#24，比照第 9 節的 0 個小節）：「最後一個聲部不能刪」只擋得住同一份文件裡的刪除。兩人同時各刪掉最後兩個聲部中的一個，合併後團譜一個聲部都沒有。伺服器不自動補聲部；能恢復的方式在客戶端：
    - 讀取與繪製照常：`readScore` 讀出 `parts: []`，沒有 Flag。alphaTab 排不了、也產生不了沒有 track 的譜的聲音（會丟例外），所以 `score-render` 的引擎在沒有小節**或**沒有聲部時都不交給它（`alphaTabEngine.ts` 的 `drawNothing`：清掉畫過的東西、停止播放、照常回報畫完）；在那之前 `load()` 不產生聲音、`play()` 不播放（alphaTab 手上還是舊的譜）。只有鼓聲部的譜照常交給 alphaTab。
    - 游標所在的聲部不在了、又沒有地方可放（`startOfScore` 是 null）時，游標變成 null；之後團譜一有聲部（自己從面板加的、自己復原的、別人加的），游標就回到譜首。打開時就沒有地方放游標的 session（0 個小節或 0 個聲部）一開始就是這個狀態（`EditorSession` 的 `stranded`）。
    - 沒有游標時，復原、重做與聲部面板、標題列的設定類指令照常執行（它們不需要游標），其他按鍵不處理。
    - 測試：`packages/score-model/tests/parts.test.ts`、`packages/score-editor/tests/parts.test.ts`、`packages/score-render/tests/engine.test.ts`，以及 `apps/web/e2e/parts.spec.ts` 的兩個 e2e（打開一份沒有聲部的團譜、從面板新增後繼續打譜；兩位成員同時刪除之後按 `Ctrl+Z`）。
  - **補充**（#24）：刪除確認對話框開著時，那個聲部被別人刪掉，對話框關閉、不再記著要刪的聲部，聲部之後被復原也不會自己再跳出來。
- `replaceScore(json)`：還原版本用。在一筆交易裡以版本的內容取代 `meta` 的 `title`、`artist`，以及所有小節與聲部；保留版本裡的 id；是一個復原步驟。流程見 [`collab.md`](collab.md)。**補充**（#68）：score-model 的 `replaceScore(doc, version, migrations?)`（`migrateJson` 再 `jsonToDoc`）；`EditorSession.replaceScore(version)` 和其他設定類指令一樣不需要游標、唯讀時拒絕，讀不懂的版本回 false、不改文件；游標所在的小節或聲部不在版本裡時回到譜首。測試：`packages/score-model/tests/restore.test.ts`、`packages/score-editor/tests/restore.test.ts`。

## 8. 復原

- `UndoManager` 以分頁為單位，重新整理後清空。
- `trackedOrigins` 是 `LOCAL`：只復原自己的動作（ADR 0001）。
- 追蹤範圍是 `bars`、`parts`，**加上 `meta`**（`packages/score-editor/src/session.ts` 的 `createEditorSession`，#20）。改標題的 Command 是 `commands.ts` 的 `setTitle`。
- 所有 Command 都可以復原，包含結構操作、設定類與 `replaceScore`。
- `Ctrl+Z` 復原；`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做。復原之後，游標用 `settleCursor` 重新解析。
- **補充**（#20）：每個 Command 一個步驟，由 `EditorSession` 在這個成員的每一筆交易之前呼叫 `stopCapturing()` 分開（唯一的例外是兩位數格號的第二個數字，見 5.1）；所以不經按鍵執行的 Command 也各是一個步驟。測試在 `packages/score-editor/tests/undo.test.ts`：每一個 Command、兩個平台的每一個組合。
- 樂句編輯器的復原堆疊也在本機，重新整理後清空（[`phrases.md`](phrases.md)）。

## 9. 同時修改時的規定

- **刪除小節**：刪除之後才同時送到那些小節裡的內容會消失。這是「無聲消失」原則的明確例外（ADR 0002 增補）。復原時，刪除當下的內容會回來（Yjs 在同一筆交易裡刪除父節點與子節點）；之後別人送到的拍點不保證會回來。用 vitest 鎖住這個行為，仿照 `packages/score-model/tests/coediting.test.ts` 的「undo takes back only what the member did」。
  - **補充**（#22）：鎖住的結果（`packages/score-model/tests/bars.test.ts` 的「deleting bars while another member types in them」）：另一位成員在刪除送到之前打進那個小節的拍點，合併後消失；復原之後小節與刪除當下的拍點回來，那個拍點不回來。兩份文件最後一致。
  - **補充**（#22）：「至少留下 1 個小節」只擋得住同一份文件裡的刪除。兩個人同時各刪掉最後兩個小節中的一個，合併後團譜一個小節都沒有。伺服器不自動補小節（那會改寫成員的意圖）；能恢復的方式在客戶端：
    - 讀取與繪製照常：`readScore` 讀出 `bars: []`、每個聲部 `content: {}`，沒有 Flag；alphaTab 排不了沒有小節的譜（會丟例外），所以 `score-render` 的引擎不交給它，把畫過的東西清掉、照常回報畫完（`alphaTabEngine.ts` 的 `drawNothing`）。殼照樣顯示「＋小節」按鈕。
    - 游標所在的小節不在了、又沒有地方可放（`startOfScore` 是 null）時，游標變成 null；之後團譜一有小節（別人加的、自己復原的），游標就回到譜首（`EditorSession` 的 `stranded`）。
    - 沒有游標時，只有復原、重做與「＋小節」能執行（`KeyCommand.runWithoutCursor`），其他按鍵不處理。復原把自己刪掉的那個小節帶回來，游標回到譜首。「＋小節」在沒有小節時插入第一個小節（4/4，因為沒有相鄰的拍號可沿用），游標放到譜首、用這個成員在那個聲部上次的 `line`（`commands.ts` 的 `appendBar(doc, null)`），可以接著打譜。
    - 測試：`packages/score-model/tests/bars.test.ts`、`packages/score-editor/tests/bars.test.ts`，以及 `apps/web/e2e/bars.spec.ts` 的兩個 e2e（打開一份沒有小節的團譜、按「＋小節」繼續打譜；兩位成員同時刪除之後按 `Ctrl+Z`）。
- **補充**（#22）：**復原自己插入的小節**：別人在那之後打進那個小節的拍點，跟著小節一起消失（Yjs 復原時刪除小節，連同裡面所有的內容，不分是誰寫的）；重做時小節帶著那些拍點一起回來。鎖在 `packages/score-model/tests/bars.test.ts` 的「undoing a bar one inserted takes away what another member typed in it meanwhile」。
- **放置與貼上小節段**：在既有的 `Y.Array` 上先刪再插，同時輸入的內容保留（5.7）。
- **內容容器**：客戶端不補缺少的容器，只有伺服器補（[`collab.md`](collab.md)）。
- **新團譜的初始內容**由伺服器建立。

## 10. 聲部預設與建立團譜

預設表（每一項都帶好 `kind`、`tuning`、`staves`、`program`）：

| 預設 | kind | tuning（第 1 弦在前） | staves | program |
|---|---|---|---|---|
| 吉他 6 弦 | fretted | `[64, 59, 55, 50, 45, 40]` | `[{ clef: "tab" }]` | 25 |
| 吉他 7 弦 | fretted | `[64, 59, 55, 50, 45, 40, 35]` | `[{ clef: "tab" }]` | 25 |
| 貝斯 4 弦 | fretted | `[43, 38, 33, 28]` | `[{ clef: "tab" }]` | 33 |
| 貝斯 5 弦 | fretted | `[43, 38, 33, 28, 23]` | `[{ clef: "tab" }]` | 33 |
| 鼓 | percussion | `[]` | `[{ clef: "neutral" }]` | 0（打擊樂聲道） |
| 鍵盤 | pitched | `[]` | `[{ clef: "treble" }, { clef: "bass" }]` | 0 |
| 人聲 | pitched | `[]` | `[{ clef: "treble" }]` | 53 |

- **補充**（#53）：這張表在 `score-model` 的 `PART_PRESETS`（`src/presets.ts`），名稱在 `apps/web/src/strings.ts` 的 `presets`；樂句庫的「新增樂句」先用它。
- program 的依據：吉他沿用 spike 的預設 25（`schema.ts` 的 `KIND_DEFAULTS`）；人聲沿用前身的 `VOICE_PROGRAM`（前身 `converter.py:506`）。
- 新聲部的 `capo` 是 0。
- 名稱用預設的名稱加編號：「吉他 1」「吉他 2」「貝斯 1」「鼓 1」……（補充：7 弦吉他與 6 弦吉他共用「吉他」這個名稱的編號，4 弦與 5 弦貝斯共用「貝斯」）。
  - **補充**（#11）：只有一個也編號（「鼓 1」）。聲部的名稱是團譜的內容、由伺服器寫入，所以基本名稱放在 `score-model` 的 `PRESET_BASE_NAMES`，編號是 `partNames`：接在團譜裡同一個基本名稱的最大編號之後（已有「吉他 1」「吉他 3」時，新的是「吉他 4」）。選單裡的預設名稱仍在 `strings.ts` 的 `presets`。

Fretted 的調弦選項，依弦數套用：

| 選項 | 規則 |
|---|---|
| 標準 | 預設表的調弦 |
| Drop | 最低弦降全音（−2） |
| 降半音 | 每條弦 −1 |
| 降全音 | 每條弦 −2 |
| 逐弦自訂 | 每條弦各自設定 MIDI 音高（介面顯示音名，例如 E2） |

- **補充**（#11）：標準、Drop、降半音、降全音是 `score-model` 的 `tuningFor(option, strings)`；「依弦數套用」是以那個弦數的預設為標準：4 弦是貝斯 4 弦、5 弦是貝斯 5 弦、6 弦是吉他 6 弦、7 弦是吉他 7 弦。音名是 `pitchName`，中央 C（60）是 C4，黑鍵寫成升。

建立團譜的對話框：

- 欄位：標題、聲部（預設表加上數量，同一種預設可以加好幾次）、拍號、速度。
  - **補充**（#11）：聲部一行一種預設，各有數量與（fretted 的）調弦；同一行的聲部調弦相同，要不同的調弦就再加一行。介面在 `apps/web/src/components/NewScoreDialog.vue`；超過上限時顯示提示、停用「建立」。
- 預設值：4/4、120、8 小節。
- **補充**：至少要選 1 個聲部；聲部上限同第 7.1 節；拍號與速度的範圍同 [`schema.md`](schema.md) 第 3 節。
- 建立由伺服器做：伺服器以參與者身分建立文件與初始內容（[`collab.md`](collab.md)）。

owner 在 2026-11-13 確認了預設表與這些預設值（[`README.md`](README.md) 的「owner 的裁定」）。

## 11. 上限

- 聲部：總共 16 個，其中非鼓聲部最多 15 個。
- 小節：1000 個（補充：所有會增加小節的 Command 都檢查）。
- 文字：見 [`schema.md`](schema.md) 第 13 節。
- 值的巢狀深度：64 層（補充，#102；第 1 節、[`schema.md`](schema.md) 第 13 節）。
