# 鍵位

打譜的鍵位。這份表就是規格，不要求和 Guitar Pro 一致。每個鍵觸發的 Command 的語意見 [`commands.md`](commands.md)。標「補充」的鍵是設計對質沒有逐一指定、由 spec 撰寫者依總規則補上的。

## 1. 總規則

- **不帶修飾鍵的字母和數字是「輸入音符」**，意義依聲部種類而定。
- **`Shift`＋字母是技巧與拍點旗標**，三種聲部共用同一個字母；不適用於目前聲部種類的鍵，不動。
- **`Ctrl` 是結構、剪貼簿、復原。**
- 總規則暫定，等 owner 確認（[`README.md`](README.md) 的「等待 owner 裁定」）。

### 1.1 比對方式

- 帶修飾鍵的快捷鍵，以及 `[`、`]`，一律用 `KeyboardEvent.code` 比對。理由：macOS 的 Option+1 送出的 `key` 是「¡」；非美式鍵盤的 `[`、`]` 位置不同。
- **補充**：不帶修飾鍵的字母、數字、`+`、`-`、`.` 也用 `code` 比對（例如 `KeyK`、`Digit3`、`Numpad3`、`Equal`、`NumpadAdd`）。理由：台灣的成員常開著注音輸入法，`key` 可能不是字母本身；用實體位置比對，不受輸入法與鍵盤配置影響。
- 修飾鍵要完全相符：表上沒有 `Shift` 的鍵，按著 `Shift` 時不觸發（`+` 例外，見下表）。
- `event.isComposing` 為真的事件一律忽略。
- **補充**：按住不放的自動重複（`event.repeat`），只對移動、`+`、`-` 有效；輸入音符與切換技巧忽略重複，避免一次灌進一串音。
- 焦點在文字輸入框（歌詞、`text`、面板的欄位）時，按鍵屬於輸入框，不是快捷鍵（`Esc`、`Enter` 等模式鍵除外，見第 6 節）。
- 處理了的按鍵呼叫 `preventDefault()`。**例外**：`Ctrl+C`、`Ctrl+X`、`Ctrl+V` 不攔，讓瀏覽器觸發 `copy`、`cut`、`paste` 事件，剪貼簿的工作在那些事件裡做（[`phrases.md`](phrases.md)）。Windows 的舊組合 `Shift+Insert`（貼上）、`Shift+Delete`（剪下）也會觸發同樣的事件，照同樣的規則處理（補充）。

### 1.2 禁用的組合

不得綁定瀏覽器擋不住、或會搶走焦點的組合：

- `Ctrl+T`、`Ctrl+W`、`Ctrl+N`、`Ctrl+Shift+T`、`Ctrl+Shift+N`、`Ctrl+Shift+W`、`Ctrl+Tab`、`Ctrl+PageUp`、`Ctrl+PageDown`、`Alt+F4`。
- `Ctrl+B`（Firefox 的書籤側欄）。
- **補充**：也避開 `Ctrl+L`、`Alt+D`、`F6`（網址列）、`F5`、`Ctrl+R`（重新整理）、`F7`（游標瀏覽）、`F9`（Firefox 的閱讀模式）、`F10`、`F11`、`F12`、`Ctrl+Shift+I`、`Ctrl+P`、`Ctrl+F`、`Ctrl+H`、`Ctrl+J`、`Ctrl+D`、`Ctrl+E`、`Ctrl+K`、`Ctrl+U`、`Ctrl+Shift+B`、`Ctrl++`、`Ctrl+-`、`Ctrl+0`（縮放），以及 `Alt`＋字母（Windows 版 Firefox 的選單）。
- 已知風險：Linux 版 Chrome 的 `Alt+1..8` 是切換分頁，頁面能不能擋下沒有證據（[`README.md`](README.md) 的「等待 owner 裁定」）。

### 1.3 macOS

macOS 的鍵位等 owner 裁定「成員用哪些桌面作業系統」。暫定只有 Windows、Linux 的鍵位，下表也只有這一欄。如果包含 macOS，這裡要加一欄 Mac 鍵位：剪貼簿與復原改用 `Cmd`；換小節、換聲部改用 Option＋方向鍵（macOS 預設把 `Ctrl`＋方向鍵給 Mission Control 與切換桌面，瀏覽器收不到）；聲線切換與 pitched 的移八度也要檢查有沒有衝突。

## 2. 共通鍵

| 鍵（Windows／Linux） | 比對的 `code` | 動作 |
|---|---|---|
| `←` `→` | `ArrowLeft` `ArrowRight` | 前一個／後一個拍點；附加位置的規則見 [`commands.md`](commands.md) 第 3 節 |
| `↑` `↓` | `ArrowUp` `ArrowDown` | fretted：上一條／下一條弦。percussion：譜表位置。pitched：依自然音階上下一級（一個譜表位置） |
| `Ctrl+←` `Ctrl+→` | 同上加 `ctrlKey` | 前一個／後一個小節 |
| `Ctrl+↑` `Ctrl+↓` | 同上加 `ctrlKey` | 依序經過各譜表，再到上一個／下一個聲部 |
| `Home` `End` | `Home` `End` | 小節的頭／尾 |
| `Insert` | `Insert` | 在游標拍點之前插入休止拍點；在附加位置上就是附加 |
| `Delete`；`Backspace`（補充） | `Delete` `Backspace` | 刪除音符；在空拍點上刪除拍點。有選取時見 [`commands.md`](commands.md) 5.6 |
| `Ctrl+Insert` | `Insert` 加 `ctrlKey` | 在游標小節之前插入小節（結構操作） |
| `Ctrl+Shift+Insert`（補充） | `Insert` 加 `ctrlKey`、`shiftKey` | 在游標小節之後插入小節（結構操作） |
| `Ctrl+Delete` | `Delete` 加 `ctrlKey` | 刪除小節範圍，或游標小節（結構操作） |
| `+` | `Equal`（有沒有 `Shift` 都可以）、`NumpadAdd` | 時值變短，沿用 spike 的方向（`commands.ts:215`） |
| `-` | `Minus`、`NumpadSubtract` | 時值變長 |
| `.` | `Period`、`NumpadDecimal` | 附點 0 → 1 → 2 → 0 |
| `Shift+←` `Shift+→` | 加 `shiftKey` | 延伸拍點範圍 |
| `Shift+Ctrl+←` `Shift+Ctrl+→` | 加 `shiftKey`、`ctrlKey` | 延伸小節範圍 |
| `Ctrl+C` `Ctrl+X` `Ctrl+V` | `KeyC` `KeyX` `KeyV` 加 `ctrlKey` | 複製／剪下／貼上（經由 `copy`、`cut`、`paste` 事件） |
| `Ctrl+Z` | `KeyZ` 加 `ctrlKey` | 復原 |
| `Ctrl+Y`、`Ctrl+Shift+Z` | `KeyY` 加 `ctrlKey`；`KeyZ` 加 `ctrlKey`、`shiftKey` | 重做 |
| `Alt+1` `Alt+2` | `Digit1` `Digit2` 加 `altKey` | 切換到第 1／第 2 條聲線 |
| `F8` | `F8` | 跳到下一個 Flag；工具列另有同功能的按鈕，因為 macOS 的 `F8` 預設是媒體鍵 |
| `Space`（補充） | `Space` | 播放／暫停（編輯視圖從游標所在小節開始，有選取時循環選取範圍，見 [`playback.md`](playback.md)） |
| `Esc`（補充） | `Escape` | 取消選取；關閉 popover 或面板，焦點回到譜面 |

## 3. `Shift`＋字母：技巧與拍點旗標

| 鍵 | `code` | 動作 | 適用的聲部 |
|---|---|---|---|
| `Shift+L` | `KeyL` | tie | fretted、pitched |
| `Shift+H` | `KeyH` | legato（搥弦、勾弦） | fretted |
| `Shift+S` | `KeyS` | slideOut：legato → shift → outUp → outDown → 沒有 | fretted |
| `Shift+E`（補充） | `KeyE` | slideIn：inBelow → inAbove → 沒有 | fretted |
| `Shift+B` | `KeyB` | 依序切換 bend 的預設型：bend → bendRelease → preBend → preBendRelease → 沒有；新的 bend 是 2 個半音（補充） | fretted |
| `Shift+↑` `Shift+↓`（補充：fretted 的部分） | `ArrowUp` `ArrowDown` 加 `shiftKey` | fretted：bend 的半音數加減 1（1–4）。pitched：移一個八度 | fretted、pitched |
| `Shift+V` | `KeyV` | vibrato | fretted |
| `Shift+P` | `KeyP` | palm mute | fretted |
| `Shift+I` | `KeyI` | let ring | fretted |
| `Shift+X` | `KeyX` | dead note（在沒有音的弦上建立沒有格號的 dead note） | fretted |
| `Shift+G` | `KeyG` | ghost | fretted、percussion |
| `Shift+A` | `KeyA` | accent | 全部 |
| `Shift+C`（補充） | `KeyC` | staccato | fretted、pitched |
| `Shift+N`（補充） | `KeyN` | harmonic：natural → pinch → artificial → 沒有 | fretted |
| `Shift+K`（補充） | `KeyK` | tap | fretted |
| `Shift+U`（補充） | `KeyU` | stroke（拍點）：down → up → 沒有 | fretted |
| `Shift+J`（補充） | `KeyJ` | slap／pop（拍點）：slap → pop → 沒有 | fretted |
| `Shift+F`（補充） | `KeyF` | dynamic（拍點）：沒有 → pp → p → mp → mf → f → ff → 沒有 | 全部 |
| `Shift+R` | `KeyR` | 清空拍點，成為休止 | 全部 |
| `Shift+T` | `KeyT` | 三連音 | 全部 |

有選取時，這些鍵作用在整個選取範圍（[`commands.md`](commands.md) 5.4）。

## 4. 各聲部種類的輸入鍵

### 4.1 Fretted

| 鍵 | `code` | 動作 |
|---|---|---|
| `0`–`9` | `Digit0`–`Digit9`、`Numpad0`–`Numpad9` | 在游標所在的弦與拍點寫入格號。600 ms 內的兩個數字合成一個格號（最大 36），一個復原步驟 |

### 4.2 Percussion

- 字母鍵是切換：再按一次，就從拍點上移除該鼓件。
- `Delete`：移除畫在游標那條線上的**所有**鼓件。理由：好幾個鼓件畫在同一條線上（`spike-report.md:287-301`），只刪一個會有歧義。
- `↑` `↓`：移動譜表位置。
- 18 個鼓件的對應如下；id 對照 `packages/score-render/src/drums.ts:15-34`，譜表位置見 [`schema.md`](schema.md) 7.1。

| 鍵 | `code` | 鼓件 | articulation id |
|---|---|---|---|
| `K` | `KeyK` | kick | 36 |
| `S` | `KeyS` | snare | 38 |
| `D` | `KeyD` | side stick | 37 |
| `F` | `KeyF` | rim shot | 91 |
| `H` | `KeyH` | hi-hat closed | 42 |
| `J` | `KeyJ` | hi-hat half open | 92 |
| `O` | `KeyO` | hi-hat open | 46 |
| `P` | `KeyP` | hi-hat pedal | 44 |
| `1` `2` `3` `4` | `Digit1`–`Digit4`、`Numpad1`–`Numpad4` | tom high／mid／low／floor | 48／47／45／43 |
| `C` | `KeyC` | crash | 49 |
| `R` | `KeyR` | ride | 51 |
| `B` | `KeyB` | ride bell | 53 |
| `N` | `KeyN` | china | 52 |
| `M` | `KeyM` | splash | 55 |
| `W` | `KeyW` | cowbell | 56 |

### 4.3 Pitched

| 鍵 | `code` | 動作 |
|---|---|---|
| `A`–`G` | `KeyA`–`KeyG` | 在最靠近游標位置的那個八度輸入音符，並依調號套用升降記號。拍點上已經有音時再按，是加入和弦音 |
| `]` | `BracketRight` | 把游標那條線上的音升高半音（拼成升）。做法是重設音符鍵（例如 `n60` 改成 `n61`），算一個 Command |
| `[` | `BracketLeft` | 把游標那條線上的音降低半音（拼成降） |
| `Shift+↑` `Shift+↓` | `ArrowUp` `ArrowDown` 加 `shiftKey` | 移一個八度 |
| `↑` `↓` | `ArrowUp` `ArrowDown` | 依自然音階上下：`score-model` 的純函式由「clef 加譜表位置」得出自然音的音高 |

拼寫的規則見 [`schema.md`](schema.md) 8.1。

## 5. 面板與模式的鍵

| 鍵 | `code` | 動作 |
|---|---|---|
| `Enter`（補充） | `Enter`、`NumpadEnter` | 在游標拍點開 `text` 輸入框（三種聲部都有） |
| `Shift+Enter`（補充） | `Enter` 加 `shiftKey` | 進入歌詞模式（只有 pitched 聲部） |
| `F2`（補充） | `F2` | 開關小節屬性面板（游標所在小節的拍號、速度、調號、段落名稱、反覆、volta、弱起）。開啟時焦點進面板，`Esc` 關閉並回到譜面 |
| `F4`（補充） | `F4` | 開關樂句側欄（只有可編輯視圖有）。開啟時焦點進側欄的搜尋框 |
| `Enter`（在樂句側欄裡，補充） | `Enter` | 焦點在某個樂句、或它的預覽 popover 開著時：放到游標所在的小節 |
| `F8` | `F8` | 下一個 Flag（見第 2 節） |

`F2`、`F4` 都沒有瀏覽器的預設功能；如果 owner 裁定包含 macOS，要和 `F8` 一樣檢查媒體鍵的衝突。

## 6. 文字輸入模式

### 6.1 `text`（三種聲部都有）

- 在游標拍點開一個內嵌輸入框，內容預先填入現有的 `text`。
- `Enter`：存入（一個 Command）並關閉；空字串表示移除。
- `Esc`：不存，關閉。
- 64 字元以內。
- 段落名稱（`section`）從小節屬性面板編輯，不在這裡。

### 6.2 歌詞模式（只有 pitched 聲部）

- 在游標拍點旁邊開一個內嵌輸入框，內容預先填入現有的音節。游標拍點是休止時，從同一聲線的下一個非休止拍點開始（補充）。
- `Space`：存入音節，跳到同一聲線的下一個非休止拍點（可以跨小節）。
- `-`：存入「音節加上 `-`」，表示字還沒結束，再跳到下一個。
- 輸入框是空的時按 `Space`：存入空字串，也就是延長（melisma）。
- **補充**：輸入框是空的時按 `Delete`：移除這個拍點的歌詞（不是延長），跳到下一個。
- **補充**：`Enter`：存入並離開歌詞模式。
- `Esc`：不存目前的輸入，離開歌詞模式。
- **補充**：已經是最後一個非休止拍點時，存入後離開歌詞模式。
- 每存一個音節是一個 Command。32 字元以內。

## 7. 介面上的對應按鈕

- 工具列：Flag 總數與「下一個 Flag」、播放、插入小節、刪除小節（補充：很多筆電沒有 `Insert` 鍵）、復原、重做。
- 譜尾：「＋小節」按鈕。
- 唯讀編輯視圖：會改動文件的鍵第一次按到時提示「檢視者無法修改」，之後不再提示（[`views.md`](views.md)）。
