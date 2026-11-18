# 鍵位

打譜的鍵位。這份表就是規格，不要求和 Guitar Pro 一致。每個鍵觸發的 Command 的語意見 [`commands.md`](commands.md)。標「補充」的鍵是設計對質沒有逐一指定、由 spec 撰寫者依總規則補上的。

## 1. 總規則

- **不帶修飾鍵的字母和數字是「輸入音符」**，意義依聲部種類而定。
- **`Shift`＋字母是技巧與拍點記號**，三種聲部共用同一個字母；不適用於目前聲部種類的鍵，不動。
- **`Mod` 是結構、剪貼簿、復原**：Windows、Linux 是 `Ctrl`，macOS 是 `Cmd`（第 1.3 節）。
- owner 在 2026-11-13 確認了這三條總規則（[`README.md`](README.md) 的「owner 的裁定」）。

### 1.1 比對方式

- 帶修飾鍵的快捷鍵，以及 `[`、`]`，一律用 `KeyboardEvent.code` 比對。理由：macOS 的 Option+1 送出的 `key` 是「¡」；非美式鍵盤的 `[`、`]` 位置不同。
- **補充**：不帶修飾鍵的字母、數字、`+`、`-`、`.` 也用 `code` 比對（例如 `KeyK`、`Digit3`、`Numpad3`、`Equal`、`NumpadAdd`）。理由：台灣的成員常開著注音輸入法，`key` 可能不是字母本身；用實體位置比對，不受輸入法與鍵盤配置影響。
- 修飾鍵要完全相符：組合裡沒有的修飾鍵，按著時不觸發（`+` 例外，見下表）。這也包括 Windows、Linux 的 `metaKey`（Windows 鍵）與 macOS 的 `ctrlKey`。
- `event.isComposing` 為真的事件一律忽略。**補充**：`keyCode` 是 229 的事件也忽略。理由：Safari 在結束組字的那一次 keydown（例如用 `Enter` 或 `Space` 選字）送出的 `isComposing` 是 false、`keyCode` 是 229；不忽略的話，用注音打歌詞時，選字的 `Space` 會同時存入音節並跳到下一拍。這條也適用於第 6 節的文字輸入模式。
- **補充**：按住不放的自動重複（`event.repeat`），只對移動、`+`、`-` 有效；輸入音符與切換技巧忽略重複，避免一次灌進一串音。
- 焦點在文字輸入框（歌詞、`text`、面板的欄位）時，按鍵屬於輸入框，不是快捷鍵（`Esc`、`Enter` 等模式鍵除外，見第 6 節）。
- 處理了的按鍵呼叫 `preventDefault()`。**例外**：`Mod+C`、`Mod+X`、`Mod+V` 不攔，讓瀏覽器觸發 `copy`、`cut`、`paste` 事件，剪貼簿的工作在那些事件裡做（[`phrases.md`](phrases.md)）。Windows 的舊組合 `Shift+Insert`（貼上）、`Shift+Delete`（剪下）也會觸發同樣的事件，照同樣的規則處理（補充）。

### 1.2 禁用的組合

不得綁定作業系統先拿走、瀏覽器擋不住、或會搶走焦點的組合。這兩份清單也是平台層測試用的資料（第 1.3 節）。

**Windows、Linux**

- `Ctrl+T`、`Ctrl+W`、`Ctrl+N`、`Ctrl+Shift+T`、`Ctrl+Shift+N`、`Ctrl+Shift+W`、`Ctrl+Tab`、`Ctrl+PageUp`、`Ctrl+PageDown`、`Alt+F4`。
- `Ctrl+B`（Firefox 的書籤側欄）。
- **補充**：也避開 `Ctrl+L`、`Alt+D`、`F6`（網址列）、`F5`、`Ctrl+R`（重新整理）、`F7`（游標瀏覽）、`F9`（Firefox 的閱讀模式）、`F10`、`F11`、`F12`、`Ctrl+Shift+I`、`Ctrl+P`、`Ctrl+F`、`Ctrl+H`、`Ctrl+J`、`Ctrl+D`、`Ctrl+E`、`Ctrl+K`、`Ctrl+U`、`Ctrl+Shift+B`、`Ctrl++`、`Ctrl+-`、`Ctrl+0`（縮放），以及 `Alt`＋字母（Windows 版 Firefox 的選單）。
- **補充**：`Ctrl+Alt`＋任何鍵。理由：Linux 的桌面環境用它切換工作區、開終端機；Windows 上歐系鍵盤的 `AltGr` 送出的就是 `Ctrl+Alt`。
- 已知風險：Linux 版 Chrome 的 `Alt+1..8` 是切換分頁，頁面能不能擋下沒有證據。確認的方法與擋不下時的改法見第 1.3 節。

**macOS**

- 作業系統先拿走、瀏覽器收不到：`Ctrl`＋方向鍵（Mission Control、App Exposé、切換桌面）、`Ctrl+Space` 與 `Ctrl+Option+Space`（切換輸入法；成員切換注音時常用）、`Cmd+Space`（Spotlight）、`Cmd+Tab`、`` Cmd+` ``、`Cmd+H`、`Cmd+Option+H`、`Cmd+M`、`Cmd+Q`、`Cmd+Option+Esc`、`Cmd+Shift+3`、`Cmd+Shift+4`、`Cmd+Shift+5`（截圖）、`Ctrl+Cmd+Q`（鎖定螢幕）、`Ctrl+Cmd+Space`（表情符號）、`Cmd+Option+D`（Dock）。
- 瀏覽器保留或會搶走焦點：`Cmd+T`、`Cmd+W`、`Cmd+N`、`Cmd+Shift+T`、`Cmd+Shift+N`、`Cmd+Shift+W`；切換分頁的 `Cmd+1`–`Cmd+9`、`Cmd+Option+←`、`Cmd+Option+→`、`Cmd+Shift+[`、`Cmd+Shift+]`、`Ctrl+Tab`；`Cmd+L`（網址列）；`Cmd+R`、`Cmd+Shift+R`（重新整理）；`Cmd+[`、`Cmd+]`、`Cmd+←`、`Cmd+→`（上一頁、下一頁）；`Cmd+F`、`Cmd+G`、`Cmd+E`（尋找）；`Cmd+P`、`Cmd+S`、`Cmd+D`；`Cmd+Y`（歷史記錄）；`Cmd+I`（Safari 用郵件寄送網頁）；`Cmd+Shift+B`、`Cmd+Option+B`（書籤）；`Cmd+,`（設定）；`Cmd+=`、`Cmd+-`、`Cmd+0`（縮放）；`Cmd+Option+I`、`Cmd+Option+J`、`Cmd+Option+C`、`Cmd+Option+U`（開發者工具、原始碼）；`Ctrl+Cmd+F`（全螢幕）。
- 不帶 `Fn` 的 `F1`–`F12`：macOS 預設是亮度、Mission Control、Spotlight、聽寫、媒體與音量鍵。用到功能鍵的地方，Mac 寫成 `Fn`＋功能鍵，而且介面上要有同功能的按鈕（第 5、7 節）。
  - **補充**：頁面分不出「不帶 `Fn` 的 `F1`–`F12`」和「`Fn`＋功能鍵」：兩者送出同一個 `code`（例如 `F8`）。所以這一項不寫進平台層的禁用資料（`packages/score-editor/src/bindings.ts` 的 `FORBIDDEN_KEYS.mac`），測試也擋不了；用到功能鍵的功能，靠介面上同功能的按鈕保住（第 5、7 節）。
- `Option`＋字母、`Option`＋數字會打出字元：例如 `Option+1` 是「¡」；`Option+E`、`Option+I`、`Option+N`、`Option+U`、`` Option+` `` 是組合重音符號用的 dead key。焦點在譜面時，因為用 `code` 比對，不會打出字；焦點在文字輸入框時，按鍵屬於輸入框（第 1.1 節）。Mac 只用 `Option+1`、`Option+2`、`Option`＋方向鍵與 `Option+Return`，不綁 `Option`＋字母，避免和 dead key 互相干擾。

### 1.3 平台層

表上的組合寫成**抽象組合**，由 `packages/score-editor` 的平台層換成各平台實際的按鍵。

| 抽象 | Windows、Linux | macOS | 用在 |
|---|---|---|---|
| `Mod` | `Ctrl`（`ctrlKey`） | `Cmd`（`metaKey`） | 結構、剪貼簿、復原 |
| `Nav` | `Ctrl`（`ctrlKey`） | `Option`（`altKey`） | 只和方向鍵一起用：換小節、換譜表與聲部、延伸小節範圍。理由：macOS 把 `Ctrl`＋方向鍵給 Mission Control 與切換桌面，`Cmd+←`、`Cmd+→` 又是上一頁、下一頁 |
| `Alt` | `Alt`（`altKey`） | `Option`（`altKey`） | 切換聲線。Mac 不用 `Mod`，因為 `Cmd+1`–`Cmd+9` 是瀏覽器的切換分頁 |
| `Shift` | `Shift` | `Shift` | 技巧、延伸選取 |

- macOS 沒有 `Insert` 鍵，所以用到 `Insert` 的三個組合在表上另外寫 Mac 的組合：`Option+Return`、`Cmd+Return`、`Cmd+Shift+Return`（`Return` 的 `code` 是 `Enter`）。這三個不是由抽象規則推出來的，平台層照表用。
- Mac 鍵盤上標著 `delete` 的鍵送出的 `code` 是 `Backspace`，`Fn+delete` 才是 `Delete`。Mac 上的 `Delete` 系列組合兩個 `code` 都接受（第 2 節）。
- 判定平台只在一個地方：`packages/score-editor` 的 `detectKeyPlatform(nav)`，回傳 `"mac"` 或 `"other"`。
  - 參數是 navigator 形狀的物件（`{ platform?: string; userAgentData?: { platform?: string } }`），所以套件仍然不碰 DOM，vitest 可以直接測。
  - `userAgentData.platform` 是 `"macOS"`，或 `platform` 以 `Mac`、`iPhone`、`iPad`、`iPod` 開頭時，結果是 `"mac"`；其他情況（Windows、Linux、ChromeOS、兩者都讀不到）是 `"other"`。iPadOS 的 Safari 回報 `MacIntel`；iPad 接實體鍵盤時也是用 `Cmd`，所以照 Mac 的鍵位。
  - Vue 殼在載入頁面時用 `navigator` 呼叫一次，把結果交給 `EditorSession`。其他地方不判斷平台，也不解析 `userAgent` 字串。
- 介面上顯示的鍵名（工具列的提示、說明文字）由同一張表與 `formatChord(chord, platform)` 產生，例如復原在 Windows 顯示 `Ctrl+Z`，在 Mac 顯示 `⌘Z`。`strings.ts` 裡不寫死任何鍵名。
  - **補充**（#20）：要某個動作的鍵名時用 `keyNameOf(effect, platform, fret?)`：取那個綁定的第一個組合，交給 `formatChord`。格號鍵用 `fret` 指定是哪一個數字。
  - **補充**（#20）：`+` 是 `Shift` 加 `=` 那個鍵；`Shift+Equal` 顯示成 `+`，不是 `Shift++` 或 `⇧+`。平台層的測試檢查表上每個組合的鍵名都沒有這種重複的 `+`。
  - **補充**（#20）：提示句子裡怎麼把鍵名接在文字上（分隔符號、順序），由 `strings.ts` 的格式化函式負責；等第一個帶鍵名的提示（第 7 節工具列按鈕的提示）出現時再加，現在還沒有這種句子。**補充**（#36）：第一句是「下一個標記」按鈕的提示，`strings.score.flags.nextKey(key)`，鍵名接在全形括號裡，例如「跳到下一個標記（F8）」；鍵名由 `keyNameOf("nextFlag", platform)` 產生。
- 平台層的測試（vitest）對表上每一個綁定、兩個平台都檢查：
  - 解析出的組合和這份文件的表相同；
  - 不在第 1.2 節的禁用清單裡；
  - 同一個平台、同一個情境裡，沒有兩個綁定解析成同一個組合；
  - 多按一個修飾鍵就不觸發，例如 Mac 上的 `Cmd+C` 不會觸發鼓的 crash（`C`）。

  之後加鍵的票只在表上加列，這些測試會自動涵蓋。
- Linux 版 Chrome 的 `Alt+1..8`：由人工判定在 Linux 上試一次（[`testing.md`](testing.md) 第 6 節第 8 項）。擋不下時，`detectKeyPlatform` 加上 `"linux"`，並在表上給聲線切換另一個 Linux 的組合；其他地方不用改。

## 2. 共通鍵

macOS 欄寫「同左」的，表示 Mac 按同一個鍵。`code` 欄裡的 `Mod`、`Nav` 是第 1.3 節的抽象修飾鍵。

| Windows、Linux | macOS | 比對的 `code` | 動作 |
|---|---|---|---|
| `←` `→` | 同左 | `ArrowLeft` `ArrowRight` | 前一個／後一個拍點；附加位置的規則見 [`commands.md`](commands.md) 第 3 節 |
| `↑` `↓` | 同左 | `ArrowUp` `ArrowDown` | fretted：上一條／下一條弦。percussion：譜表位置。pitched：依自然音階上下一級（一個譜表位置） |
| `Ctrl+←` `Ctrl+→` | `Option+←` `Option+→` | `ArrowLeft` `ArrowRight` 加 `Nav` | 前一個／後一個小節 |
| `Ctrl+↑` `Ctrl+↓` | `Option+↑` `Option+↓` | `ArrowUp` `ArrowDown` 加 `Nav` | 依序經過各譜表，再到上一個／下一個聲部 |
| `Home` `End` | `Fn+←` `Fn+→`（系統送出的就是 `Home`、`End`；有這兩個鍵的鍵盤也可以直接按） | `Home` `End` | 小節的頭／尾 |
| `Insert` | `Option+Return` | `Insert`；Mac：`Enter` 加 `altKey` | 在游標拍點之前插入休止拍點；在附加位置上就是附加 |
| `Delete`；`Backspace`（補充） | `delete`、`Fn+delete` | `Delete` `Backspace` | 刪除音符；在空拍點上刪除拍點。有選取時見 [`commands.md`](commands.md) 5.6 |
| `Ctrl+Insert` | `Cmd+Return` | `Insert` 加 `Mod`；Mac：`Enter` 加 `metaKey` | 在游標小節之前插入小節（結構操作） |
| `Ctrl+Shift+Insert`（補充） | `Cmd+Shift+Return` | 同上，加 `shiftKey` | 在游標小節之後插入小節（結構操作） |
| `Ctrl+Delete` | `Cmd+delete`、`Cmd+Fn+delete` | `Delete` 加 `Mod`；Mac：`Backspace` 或 `Delete` 加 `metaKey` | 刪除小節範圍，或游標小節（結構操作） |
| `+` | 同左 | `Equal`（有沒有 `Shift` 都可以）、`NumpadAdd` | 時值變短，沿用 spike 的方向（`commands.ts` 的 `durationStep`，由 `changeBeatAt`、`changeBeatsOnSelection` 套用） |
| `-` | 同左 | `Minus`、`NumpadSubtract` | 時值變長 |
| `.` | 同左 | `Period`、`NumpadDecimal` | 附點 0 → 1 → 2 → 0 |
| `Shift+←` `Shift+→` | 同左 | 加 `shiftKey` | 延伸拍點範圍 |
| `Ctrl+Shift+←` `Ctrl+Shift+→` | `Option+Shift+←` `Option+Shift+→` | 加 `Nav`、`shiftKey` | 延伸小節範圍 |
| `Ctrl+C` `Ctrl+X` `Ctrl+V` | `Cmd+C` `Cmd+X` `Cmd+V` | `KeyC` `KeyX` `KeyV` 加 `Mod` | 複製／剪下／貼上（經由 `copy`、`cut`、`paste` 事件） |
| `Ctrl+Z` | `Cmd+Z` | `KeyZ` 加 `Mod` | 復原 |
| `Ctrl+Y`、`Ctrl+Shift+Z` | `Cmd+Shift+Z`（不用 `Cmd+Y`：那是 Safari 與 Chrome 的歷史記錄） | `KeyZ` 加 `Mod`、`shiftKey`；Windows、Linux 另有 `KeyY` 加 `ctrlKey` | 重做 |
| `Alt+1` `Alt+2` | `Option+1` `Option+2` | `Digit1` `Digit2` 加 `altKey` | 切換到第 1／第 2 條聲線 |
| `F2`（補充，#22） | `Fn+F2` | `F2` | 開關小節屬性面板（第 5 節）。和 `F8` 一樣是 page 綁定（`pageEffectOf` 回傳 `barPanel`），由殼處理 |
| `F8` | `Fn+F8` | `F8` | 跳到下一個 Flag；工具列另有同功能的按鈕。補充（#36）：和 `Space` 一樣是 page 綁定（`pageEffectOf` 回傳 `nextFlag`），由殼從它畫的 `ScoreJSON` 算出下一個（`flags.ts` 的 `nextFlag`，[`flags.md`](flags.md) 第 4 節） |
| `Space`（補充） | 同左 | `Space` | 播放／暫停（編輯視圖從游標所在小節開始，有選取時循環選取範圍，見 [`playback.md`](playback.md)）。補充（#31）：`EditorSession` 不處理這個鍵，由殼處理（綁定表上的 page 綁定，`pageEffectOf`） |
| `Esc`（補充） | 同左 | `Escape` | 取消選取；關閉 popover 或面板，焦點回到譜面 |

**補充**（#22）：結構操作的三個鍵是 `bindings.ts` 的 `insertBarBefore`（`Mod+Insert`，Mac 是 `Mod+Enter`）、`insertBarAfter`（`Mod+Shift+Insert`，Mac 是 `Mod+Shift+Enter`）與 `deleteBars`（`Mod+Delete`，Mac 是 `Mod+Backspace`、`Mod+Delete`），Mac 的組合照表寫在 `mac` 欄，不是由抽象規則推出。修飾鍵要完全相符：Mac 上的 `Ctrl+Insert`、`Cmd+Insert` 不做事，`Option+Return` 仍然是插入拍點；Windows、Linux 上的 `Cmd`（`metaKey`）組合不做事。測試在 `packages/score-editor/tests/bars.test.ts`。

## 3. `Shift`＋字母：技巧與拍點記號

這一節的鍵在 macOS 相同：只帶 `Shift`，平台層不換，也沒有作業系統或瀏覽器的衝突。

| 鍵 | `code` | 動作 | 適用的聲部 |
|---|---|---|---|
| `Shift+L` | `KeyL` | tie | fretted、pitched（補充，#36：目前只綁 fretted，見本節最後的補充） |
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

**補充**（#26）：dead、ghost、accent、staccato、vibrato、palm mute、let ring、tap 的鍵目前只綁在 fretted 聲部（`bindings.ts` 的 `TECHNIQUE_KEYS`）。Command 以音符鍵為參數（`commands.ts` 的 `toggleAt`），目前游標那條線上的音符鍵由 `noteKeysAt` 給出。**補充**（#44）：鼓的 ghost、accent 已加上：`bindings.ts` 另有情境 `percussion` 的 `ghost`、`accent` 綁定，作用在畫在游標那條線上的**所有**鼓件（`noteKeysAt`，同 [`commands.md`](commands.md) 5.2 的 `deleteNote`），一次決定、一個 Command（`toggleKeysAt`）。五線譜的 accent、staccato 跟著 M3 加上；在那之前，這些鍵在五線譜聲部不動。鼓沒有 tie，`Shift+L` 在鼓聲部不是按鍵。

**補充**（#30）：`Shift+U`（stroke）與 `Shift+J`（slap／pop）只綁在 fretted 聲部（`bindings.ts` 的 `stroke`、`slapPop`），在鼓與五線譜聲部不是按鍵，不動；`Shift+F`（dynamic）三種聲部都有。和鼓的 `F`（rim shot）、`J`（hi-hat half open）不衝突：修飾鍵要完全相符。三者有選取時都作用在整個範圍（[`commands.md`](commands.md) 5.4 的補充）。

**補充**（#27）：`Shift+H`（legato）是 `bindings.ts` 的 `TECHNIQUE_KEYS` 裡的一項；`Shift+S`（slideOut）、`Shift+E`（slideIn）是 `slideOut`、`slideIn` 綁定。三者都只綁在 fretted 聲部（這些欄位只有 fretted 有）；有選取時作用在整個範圍，循環型的走到同一個狀態（[`commands.md`](commands.md) 5.4 的補充）。

**補充**（#28）：`Shift+B` 是 `bindings.ts` 的 `bend` 綁定；`Shift+↑`、`Shift+↓` 是 `bendUp`、`bendDown`，比對 `ArrowUp`、`ArrowDown` 加 `shiftKey`，兩個平台相同。三者目前只綁在 fretted 聲部；五線譜的 `Shift+↑`／`Shift+↓`（移八度，[`commands.md`](commands.md) 5.8）綁在 pitched 情境（#48 加上，第 4.3 節的補充），和 fretted 的不衝突。和 `↑`、`↓`（換弦）不衝突：修飾鍵要完全相符，所以 `Shift+↑` 不移動游標。按住時不重複（第 1.1 節：只有移動與 `+`、`-` 重複）。

**補充**（#29）：`Shift+N` 是 `bindings.ts` 的 `harmonic` 綁定，只綁在 fretted 聲部（這個欄位只有 fretted 有），兩個平台相同；有選取時作用在整個範圍，走到同一個泛音（[`commands.md`](commands.md) 5.4 的補充）。

**補充**（#36）：tie（`Shift+L`）同樣目前只綁在 fretted 聲部（`bindings.ts` 的 `tie` 綁定，`commands.ts` 的 `tieToggle`）；五線譜的 tie 依「同一條線」找前一個音，跟著 M3 的音符鍵加上（[`commands.md`](commands.md) 5.4 的限制）。

## 4. 各聲部種類的輸入鍵

這一節的鍵在 macOS 相同：不帶修飾鍵，或只帶 `Shift`，平台層不換。

### 4.1 Fretted

| 鍵 | `code` | 動作 |
|---|---|---|
| `0`–`9` | `Digit0`–`Digit9`、`Numpad0`–`Numpad9` | 在游標所在的弦與拍點寫入格號。600 ms 內的兩個數字合成一個格號（最大 36），一個復原步驟 |

### 4.2 Percussion

- 字母鍵是切換：再按一次，就從拍點上移除該鼓件。
- `Delete`：移除畫在游標那條線上的**所有**鼓件。理由：好幾個鼓件畫在同一條線上（`spike-report.md:287-301`），只刪一個會有歧義。
- `↑` `↓`：移動譜表位置。
- 18 個鼓件的對應如下；id 對照 `packages/score-model/src/drums.ts` 的 `DRUM_PIECES`，譜表位置見 [`schema.md`](schema.md) 7.1。
- **補充**（#44）：鍵在 `bindings.ts` 的 `DRUM_KEYS`（`drum` 綁定，情境 `percussion`，帶 `piece`），指令是 `commands.ts` 的 `toggleDrum`。

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

**補充**（#48）：鍵在 `bindings.ts`：`A`–`G` 是 `pitch` 綁定（帶 `letter`，`KeyA`–`KeyG`，不帶修飾鍵），`]`、`[` 是 `sharpen`、`flatten`（`BracketRight`、`BracketLeft`），`Shift+↑`、`Shift+↓` 是 `octaveUp`、`octaveDown`；全部綁在情境 `pitched`，兩個平台相同，按住時不重複。和鼓的 `B`、`C`、`D`、`F`（情境 `percussion`）與 fretted 的 `Shift+↑`、`Shift+↓`（bend 的半音數）不衝突：綁定只作用在它那種聲部。指令是 `commands.ts` 的 `enterNote`、`moveNotesBySemitone`、`moveNotesByOctave`（[`commands.md`](commands.md) 5.1、5.8 的補充）。`Delete` 在五線譜刪掉畫在游標那條線上的所有音（5.2）。

## 5. 面板與模式的鍵

| 鍵（Windows、Linux） | macOS | `code` | 動作 |
|---|---|---|---|
| `Enter`（補充） | `Return` | `Enter`、`NumpadEnter` | 在游標拍點開 `text` 輸入框（三種聲部都有） |
| `Shift+Enter`（補充） | `Shift+Return` | `Enter` 加 `shiftKey` | 進入歌詞模式（只有 pitched 聲部） |
| `F2`（補充） | `Fn+F2` | `F2` | 開關小節屬性面板（游標所在小節的拍號、速度、調號、段落名稱、反覆、volta、弱起）。開啟時焦點進面板，`Esc` 關閉並回到譜面 |
| `F4`（補充） | `Fn+F4` | `F4` | 開關樂句側欄（只有可編輯視圖有）。開啟時焦點進側欄的搜尋框 |
| `Enter`（在樂句側欄裡，補充） | `Return` | `Enter` | 焦點在某個樂句、或它的預覽 popover 開著時：放到游標所在的小節 |
| `F8` | `Fn+F8` | `F8` | 下一個 Flag（見第 2 節） |

**補充**（#22）：`F2` 在譜面上開關面板，只有可編輯視圖有面板（唯讀編輯視圖按 `F2` 不動）。開啟時焦點進面板的第一個欄位；面板裡的鍵屬於欄位，只有 `Esc` 與 `F2` 關閉面板、焦點回到譜面，比對照第 1.1 節（`Esc` 用 `textEntryEffectOf` 的 `cancelEntry`，`F2` 用 `pageEffectOf`）。工具列的「小節屬性」按鈕同樣開關面板，開啟時焦點進面板，關閉時回到譜面。

**補充**（#57）：`F4` 是 `bindings.ts` 的 page 鍵 `phraseSidebar`（由 `pageEffectOf` 判斷，唯讀編輯視圖與 Read view 按了不動）；工具列的「樂句側欄」按鈕提示是 `strings.score.phraseSidebar.openKey`，鍵名由 `keyNameOf("phraseSidebar", platform)` 產生。側欄裡的 `Enter` 與 `Esc` 用 `textEntryEffectOf` 比對（`saveEntry`、`cancelEntry`），所以組字中的 `Enter` 不會放置；焦點在樂句上按 `Enter` 是放置，不是按鈕的點擊（點擊是開預覽，焦點移進預覽）；焦點在預覽裡按 `Enter` 放置預覽中的樂句。側欄自己的按鈕、連結與輸入框（含預覽的「關閉預覽」、搜尋框）的 `Enter` 照它們自己的作用，不放置。`Esc` 先關預覽（焦點回到打開它的樂句），沒有預覽時關側欄。

`F2`、`F4`、`F8` 在 Windows、Linux 的瀏覽器裡沒有預設功能。macOS 的功能鍵預設是系統功能（第 1.2 節），要按著 `Fn`，或在系統設定把 F1–F12 設成標準功能鍵；所以這三個鍵在工具列都有同功能的按鈕（第 7 節）。

## 6. 文字輸入模式

Mac 上的 `Enter` 是 `Return`，`Delete` 是 `Fn+delete`（標著 `delete` 的鍵是 `Backspace`，在輸入框裡照常刪字）。組字中的按鍵一律忽略（第 1.1 節），所以用注音選字時按的 `Space`、`Enter` 不會存入。

### 6.1 `text`（三種聲部都有）

- 在游標拍點開一個內嵌輸入框，內容預先填入現有的 `text`。
- `Enter`：存入（一個 Command）並關閉；空字串表示移除。
- `Esc`：不存，關閉。
- 64 字元以內。
- 段落名稱（`section`）從小節屬性面板編輯，不在這裡。
- **補充**（#30）：輸入框的鍵也在綁定表上，情境是 `textEntry`（`bindings.ts` 的 `saveEntry`：`Enter`、`NumpadEnter`；`cancelEntry`：`Escape`），由 `textEntryEffectOf(key, platform)` 判斷；這個情境裡譜面的鍵都不作用，其餘的鍵是輸入框自己的（打字、`Backspace`、方向鍵），不傳到譜面。比對照第 1.1 節：`isComposing` 為真、或 `keyCode` 是 229 的鍵都不算，所以用注音選字的 `Enter` 不會存入。
- **補充**（#30）：輸入框開在游標下方（`apps/web/src/overlay.ts` 的 `entryRect`），照 [`views.md`](views.md) 第 9 節避開保留區域：會伸進保留區域時整個移到它下方，高度不變（不像 `clearOf` 那樣切掉）；開啟時選取現有的文字，所以直接打字就是取代、按 `Backspace` 就是清空。焦點離開輸入框（例如點譜面）時當成 `Esc`：不存。關閉後焦點回到譜面。輸入框是 `apps/web/src/components/InlineTextEntry.vue`。

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

- 工具列：Flag 總數與「下一個 Flag」、播放、插入小節、刪除小節（補充：很多筆電沒有 `Insert` 鍵，Mac 完全沒有）、復原、重做、小節屬性、樂句側欄（只有可編輯視圖有）。小節屬性與樂句側欄的按鈕是補充，理由同第 5 節：Mac 的 `F2`、`F4` 要按著 `Fn`。
- 按鈕的提示顯示這個平台的鍵，由第 1.3 節的 `formatChord` 產生。
  - **補充**（#22）：「插入小節」、「刪除小節」、「小節屬性」三個按鈕只在可編輯視圖，提示是 `strings.score.bars` 的 `insertKey`、`removeKey`、`panelKey`，鍵名由 `keyNameOf("insertBarBefore" | "deleteBars" | "barPanel", platform)` 產生：Windows、Linux 是 `Ctrl+Insert`、`Ctrl+Delete`、`F2`，Mac 是 `⌘↩`、`⌘⌫`、`F2`。復原、重做的按鈕還沒有做。
- 譜尾：「＋小節」按鈕。
- 唯讀編輯視圖：會改動文件的鍵第一次按到時提示「檢視者無法修改」，之後不再提示（[`views.md`](views.md)）。
