# Command、Cursor、Selection

編輯模型：游標、選取、每一個 Command 的語意、復原。鍵位見 [`keymap.md`](keymap.md)，文件的形狀見 [`schema.md`](schema.md)。標「補充」的是 spec 撰寫者保守補上的細節。這份文件提到的鍵用 Windows、Linux 的寫法；macOS 的對應鍵見 [`keymap.md`](keymap.md) 第 2 節。

## 1. 通則

- Command 是 `score-model` 裡的純函式 `(doc, cursor 或 selection, args) → cursor`。
- 每一個 Command 是一筆 Yjs 交易（origin 是 `LOCAL`）、一個復原步驟。
- Command 不碰 DOM，也不碰 renderer。
- `EditorSession`（`packages/score-editor`）把按鍵對應到 Command，依聲部種類分派。它帶著唯讀旗標：唯讀時，任何會改動文件的 Command 都被拒絕（見 [`views.md`](views.md)）。
- 不自動拆拍、不自動跨小節連結；超出拍號只標 Flag（ADR 0002）。
- 指令改寫音符時，以儲存的原值為底，保留不認得的欄位（[`schema.md`](schema.md) 第 9 節）。

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
- **補充**：游標所在的拍點被刪除（別人刪除或自己復原）：落在接替它位置的拍點上，也就是它後面的那個拍點；它原本是最後一個拍點時，落在前一個拍點；聲線變空就是空聲線的附加位置 `{ beatId: null, at: "after" }`。做法：`EditorSession` 每次移動游標時用 `beatPositionOf` 記下拍點的位置（Yjs 的相對位置），拍點不在了就交給 `settleCursor` 解析。
- 其他人的游標在遠端修改之後，同樣用 `settleCursor` 重新解析。**補充**：看的人這邊沒有那位成員的拍點位置，所以不帶位置解析：那位成員所在的拍點被刪除時，在看的人這邊先落在那條聲線的最後一個拍點，直到那位成員自己的 session 送出新的 presence。
- **補充**：`EditorSession` 記住每個聲部上次的 `line`；第一次進入某個聲部時，fretted 是 1，其他種類是 4（中間那條線）。換到弦數較少的聲部時夾在範圍內。

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
- **補充**：fretted 聲部按 `Alt+2` 不動，並提示「弦樂聲部只有一條聲線」（介面不提供第二聲線）。

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
  - 沒有選取時，從游標所在的拍點（`Shift+←/→`）或小節（`Shift+Ctrl+←/→`）開始。游標在附加位置時，它的拍點是錨點，也就是那條聲線的最後一個拍點；空聲線沒有拍點可選，`Shift+←/→` 不建立拍點範圍（例如譜的開頭）。
  - `Shift+←/→` 的游標照 `←`、`→` 移動（第 3 節，包括 5.1 剛輸入的拍點）。游標進入附加位置時，終點是它的錨點。
  - `Shift+Ctrl+←/→` 的游標照 `Ctrl+←/→` 移到上一個／下一個小節的第一個位置（`navigation.ts` 的 `moveByBar`）；在譜的兩端不動，範圍保留。拍點範圍用它延伸時，從拍點範圍的小節起。
  - 升級成小節範圍之後就一直是小節範圍：`Shift+←/→` 照樣移動游標，終點是游標的小節；回到起點的小節時是那一個小節的範圍。
  - 結束選取的動作：不帶 `Shift` 的移動（含 `↑`、`↓`）、`Esc`、點譜面、復原與重做，以及其他不作用在選取上的 Command（輸入音符、`Insert`、`+`、`-`）。被唯讀拒絕的 Command 沒有執行，選取不變。
  - 選取作用的 Command 目前只有 `Delete`（5.6）。時值（5.3）與技巧（5.4）作用在選取範圍的規則還沒做，在那之前它們只作用在游標拍點，並結束選取。
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

- **兩位數格號**：600 ms 內在同一個拍點、同一條弦上輸入的兩個數字，合成一個格號、一個復原步驟；合起來超過 36 時，第二個數字當成新的一次輸入（`packages/score-editor/src/session.ts` 的 `TWO_DIGIT_WINDOW`、`MAX_FRET` 與 `typeDigit`；測試在 `packages/score-editor/tests/typing.test.ts`）。現在的做法（暫時調大 `captureTimeout`）可以換掉。
- **在附加位置輸入**：建立一個新拍點並寫入音符，是一個 Command。新拍點的時值取錨點拍點的時值（`value`、`dots`、`tuplet`）；沒有錨點時是四分音符。輸入後游標移到新拍點（`at: "on"`），下一次 `→` 以它為新的錨點。
  - **補充**：別人的拍點已經接在新拍點之後時也一樣。游標還停在新拍點上（只換弦、換線不算離開）時，`→` 把它當成聲線的最後一個拍點：小節未滿就進它的附加位置，已滿或超過就到下一小節（`navigation.ts` 的 `moveFromAppendedBeat`）。否則 `→` 會走到別人的拍點上，同時打譜的兩人的拍點就不再成段。游標離開新拍點之後，`→` 照第 3 節。`Insert` 在附加位置建立的拍點也一樣。
- 在既有拍點上輸入：游標留在原拍點（這樣才能疊和弦），fretted 與 pitched 可以接著換弦、換線再輸入。
- **補充**：percussion 切換之後，`line` 移到該鼓件的譜表位置（[`schema.md`](schema.md) 7.1）。
- **pitched 的音高**：`score-model` 有一個純函式，由「clef 加譜表位置」得出自然音的音高；`A`–`G` 在所有同名的音裡，取和游標位置的自然音相差最少音級的那一個（7 個音名不會等距，所以沒有平手）。再依該小節生效的 `keySig` 套用升降（例如 G 大調的 F 變成 F♯），寫入 `spell`。**補充**：輸入後 `line` 移到新音所在的譜表位置。
- 音高超出 0–127 時不輸入。

### 5.2 插入與刪除

| Command | 鍵 | 語意 |
|---|---|---|
| `insertBeat` | `Insert` | 在游標拍點**之前**插入一個休止拍點，時值和游標拍點相同；在附加位置上就是附加（時值規則同 5.1）。游標移到新拍點 |
| `deleteNote` | `Delete`（拍點上有音） | 刪掉游標那條線上的音符：fretted 是那條弦；pitched 是畫在那條線上的所有音（補充）；percussion 是畫在那條線上的**所有**鼓件。現在只做了 fretted；percussion、pitched 跟著它們的音符鍵在 M2、M3 做，在那之前不動 |
| `deleteBeat` | `Delete`（空拍點） | 刪掉拍點 |

- percussion 的 `Delete` 刪整條線，理由：好幾個鼓件畫在同一條線上（`spike-report.md:287-301`），只刪一個會有歧義。
- **補充**：拍點上有音、但游標那條線上沒有音時，`Delete` 不動。
- **補充**：`deleteBeat` 之後，游標落在接替它位置的拍點上；沒有後面的拍點時，落在附加位置（錨點是新的最後一個拍點，聲線變空則沒有錨點）。

### 5.3 時值

| Command | 鍵 | 語意 |
|---|---|---|
| `stepDuration` | `+` `-` | 時值變短／變長一級，保留附點（`commands.ts` 的 `stepDuration`）；到 64 分或全音符就不動 |
| `cycleDots` | `.` | 附點 0 → 1 → 2 → 0（補充） |
| `toggleTriplet` | `Shift+T` | 沒有連音時設成 `{ actual: 3, normal: 2 }`，有任何連音時移除（補充） |

有選取時，套用到選取範圍內的每個拍點（補充，規則同 5.4）。

### 5.4 技巧與拍點旗標

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
- **tie**（`Shift+L`）：「加上 tie」會把格號設成前一個音的格號。這是指令本身的效果，不是自動修復。
  - fretted：同一條聲線的前一個拍點（可以在上一小節）在同一條弦上有音時，把游標那條弦的音設成 `{ ...原值, fret: 前一個音的格號, tie: true }`；那條弦原本沒有音也一樣建立。前一個拍點那條弦沒有音時：游標那條弦有音就只設 `tie: true`（之後會被標成 `danglingTie`），沒有音就不動（補充）。
  - pitched（補充）：游標那條線上有音時設 `tie: true`；那條線上沒有音、而前一個拍點同一條線上有音時，建立同一個音高與拼寫的音並設 `tie: true`。
  - 已經有 tie 時，再按一次移除 `tie`，格號不變。
- **有選取時**（補充）：音符層級的切換作用在選取範圍內、目前聲部的**每一個**音符；拍點層級的切換作用在每一個拍點。全部都已經有該值時移除，否則全部設上。是一個 Command。

### 5.5 文字與歌詞

- `setText`：在游標拍點開內嵌輸入框，`Enter` 存入；空字串表示移除。一次存入是一個 Command。
- `setLyric`（只有 pitched）：歌詞模式，見 [`keymap.md`](keymap.md)。每存一個音節是一個 Command。空字串表示延長；音節結尾的 `-` 表示字還沒結束。
- 段落名稱（`section`）從小節屬性面板編輯，是結構操作（第 6 節）。

### 5.6 清空、複製、剪下、貼上

| Command | 沒有選取 | 拍點範圍 | 小節範圍 |
|---|---|---|---|
| `Delete` | 見 5.2 | **補充**：範圍內的拍點變成休止（移除音符，保留時值與其他拍點欄位）；範圍內全部已經是休止時，刪除這些拍點 | 清空目前聲部在這些小節裡的所有聲線（變成空的聲線，也就是整小節休止）；補充（#21）：在原本的聲線上刪除，不換掉聲線，同 5.7 第 3 點 |
| `Shift+R` | 清空游標拍點的音符，成為休止（補充：只移除 `notes`，其他拍點欄位保留） | 同左，作用在範圍內每個拍點 | 同左 |
| 複製 | 不動 | 拍點段 | 小節段 |
| 剪下 | 不動 | 複製加上「清空」 | 複製加上「清空」 |
| 貼上 | 依剪貼簿的片段種類 | 同左 | 同左 |

- 剪下等於「複製加上一個清空的 Command」，所以是一個復原步驟。Viewer 只能複製，不能剪下或貼上。
- **貼上小節段**：語意和放置（5.7）相同，是取代；目標是游標所在的聲部與小節，套用 5.7 的所有規則。
- **貼上拍點段**：插入到游標所在的聲線，插在游標拍點之前，或在附加位置上附加。種類必須相同；fretted 片段用到的弦超過目標聲部的弦數時拒絕。貼上的拍點產生新的 id。游標移到最後一個貼上的拍點。
- 剪貼簿的格式與實作見 [`phrases.md`](phrases.md)。

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

### 5.8 Pitched 的升降與八度

- `]`／`[`：把游標那條線上的音升高／降低半音。做法是重設音符鍵（例如 `n60` 改成 `n61`），保留其他欄位，算一個 Command。**補充**：結果是黑鍵時，`]` 拼成升、`[` 拼成降；結果是白鍵時拼成本位。`line` 跟著音移到它新的譜表位置。
- `Shift+↑`／`Shift+↓`：把游標那條線上的音移一個八度（鍵 ±12），保留拼寫；`line` 跟著移 7 格。超出 0–127 時不動。
- 一條線上同時有好幾個音（例如 D 與 D♯）時，作用在那條線上的每一個音（補充）。

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
- **小節屬性面板**：側邊面板，顯示並編輯游標所在小節的拍號、速度、調號、段落名稱、反覆開始、反覆次數、volta、弱起（只有第一小節顯示）。開啟的鍵見 [`keymap.md`](keymap.md)。
- 新增小節後總數不得超過 1000（補充）。
- 「＋小節」、「插入小節」、「刪除小節」在工具列也有按鈕（補充：很多筆電沒有 `Insert` 鍵）。

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
- `replaceScore(json)`：還原版本用。在一筆交易裡以版本的內容取代 `meta` 的 `title`、`artist`，以及所有小節與聲部；保留版本裡的 id；是一個復原步驟。流程見 [`collab.md`](collab.md)。

## 8. 復原

- `UndoManager` 以分頁為單位，重新整理後清空。
- `trackedOrigins` 是 `LOCAL`：只復原自己的動作（ADR 0001）。
- 追蹤範圍是 `bars`、`parts`，**加上 `meta`**；現在只追蹤 `bars`、`parts`（`packages/score-editor/src/session.ts` 的 `createEditorSession`），要改。
- 所有 Command 都可以復原，包含結構操作、設定類與 `replaceScore`。
- `Ctrl+Z` 復原；`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做。復原之後，游標用 `settleCursor` 重新解析。
- 樂句編輯器的復原堆疊也在本機，重新整理後清空（[`phrases.md`](phrases.md)）。

## 9. 同時修改時的規定

- **刪除小節**：刪除之後才同時送到那些小節裡的內容會消失。這是「無聲消失」原則的明確例外（ADR 0002 增補）。復原時，刪除當下的內容會回來（Yjs 在同一筆交易裡刪除父節點與子節點）；之後別人送到的拍點不保證會回來。用 vitest 鎖住這個行為，仿照 `packages/score-model/tests/coediting.test.ts` 的「undo takes back only what the member did」。
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

- program 的依據：吉他沿用 spike 的預設 25（`schema.ts` 的 `KIND_DEFAULTS`）；人聲沿用前身的 `VOICE_PROGRAM`（前身 `converter.py:506`）。
- 新聲部的 `capo` 是 0。
- 名稱用預設的名稱加編號：「吉他 1」「吉他 2」「貝斯 1」「鼓 1」……（補充：7 弦吉他與 6 弦吉他共用「吉他」這個名稱的編號，4 弦與 5 弦貝斯共用「貝斯」）。

Fretted 的調弦選項，依弦數套用：

| 選項 | 規則 |
|---|---|
| 標準 | 預設表的調弦 |
| Drop | 最低弦降全音（−2） |
| 降半音 | 每條弦 −1 |
| 降全音 | 每條弦 −2 |
| 逐弦自訂 | 每條弦各自設定 MIDI 音高（介面顯示音名，例如 E2） |

建立團譜的對話框：

- 欄位：標題、聲部（預設表加上數量，同一種預設可以加好幾次）、拍號、速度。
- 預設值：4/4、120、8 小節。
- **補充**：至少要選 1 個聲部；聲部上限同第 7.1 節；拍號與速度的範圍同 [`schema.md`](schema.md) 第 3 節。
- 建立由伺服器做：伺服器以參與者身分建立文件與初始內容（[`collab.md`](collab.md)）。

owner 在 2026-11-13 確認了預設表與這些預設值（[`README.md`](README.md) 的「owner 的裁定」）。

## 11. 上限

- 聲部：總共 16 個，其中非鼓聲部最多 15 個。
- 小節：1000 個（補充：所有會增加小節的 Command 都檢查）。
- 文字：見 [`schema.md`](schema.md) 第 13 節。
