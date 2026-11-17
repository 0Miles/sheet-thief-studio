# Flag

Flag 是團譜裡不合規則、但系統不會自動修改的地方：只提醒，不改寫內容（ADR 0001、ADR 0002）。標「補充」的是 spec 撰寫者保守補上的細節。

## 1. 種類

| `kind` | 條件 | 適用的聲部 |
|---|---|---|
| `underfull` | 一條**非空**的聲線，拍點的 tick 總和比拍號少 0.5 tick 以上。第一小節帶 `anacrusis` 時，第一小節不標 underfull | 全部 |
| `overfull` | 一條聲線的 tick 總和比拍號多 0.5 tick 以上（弱起小節照樣標） | 全部 |
| `danglingTie` | 音符帶 `tie`，但「前一個音」不存在，或不是同一個音：fretted 看同一條弦、格號要相同；pitched 看同一個音高 | fretted、pitched（percussion 沒有 tie） |
| `danglingLink` | 音符帶 `legato`，或 `slideOut` 是 `legato`、`shift`，但同一條弦上沒有「下一個音」 | fretted |
| `invalidContent` | 讀不懂的節點，見 [`schema.md`](schema.md) 第 11 節 | 全部 |

- 空的聲線是整小節休止，不是 Flag（`flags.ts` 的 `flagsOf`）。
- **補充**（#36）：`flags.ts` 的 `flagsOf(score, invalid)` 算出 `underfull`、`overfull`（第一小節帶 `anacrusis` 時不標 underfull）與 `danglingTie`，再把 `readScore` 的 `invalidContent` 併進來，依第 3 節的順序排好。`danglingLink` 由 #27 加上（見下一條）。
- **補充**（#36）：fretted 的 `danglingTie` 要求兩個音都有格號而且相同；前一個音是沒有格號的 dead note 時，tie 也是懸空的。
- **「前一個音」**（補充）：同一聲部、同一條聲線裡，緊接在前的那個拍點（可以是上一個小節同一條聲線的最後一個拍點）上，同一個音符鍵的音。前一個拍點是休止或沒有那個鍵，就是不存在。
- **「下一個音」**（補充）：同一聲部、同一條聲線裡，緊接在後的那個拍點（可以是下一個小節同一條聲線的第一個拍點）上，同一條弦的音。
- 拍點之間的「緊接」只看同一條聲線；另一條聲線或另一個聲部的音不算。
- **補充**（#27）：`danglingLink` 的寫法是 `flags.ts` 的 `linksOn(note)`（帶 `legato`，或 `slideOut` 是 `legato`、`shift`）與 `beatAfter(beats, index, next)`（「下一個音」所在的拍點）；連不連得到由 `linkReaches(key, after)` 判斷（#28：投影與 `replaceBars` 也用它）。下一個拍點是休止、那條弦沒有音、在下一個小節而那個小節的同一條聲線是空的，或沒有下一個拍點（譜尾），都是懸空的。`outUp`、`outDown` 與 `slideIn` 不連到別的音，不會懸空。同一個音同時有懸空的連結線與連奏時是兩個 Flag，tie 在前。
- **補充**（#27）：投影用同一個「下一個音」：只有連得到時才把 `isHammerPullOrigin`、`slideOutType` 的 `Legato`、`Shift` 交給 alphaTab（[`schema.md`](schema.md) 第 8 節的補充），所以懸空的連奏不畫也不發聲，只由這個 Flag 標出來。
- 時值的 tick 算法見 [`schema.md`](schema.md) 第 6 節。

## 2. 形狀

```ts
type Flag =
  | { kind: "underfull" | "overfull"; partId: string; barId: string; voice: string }
  | { kind: "danglingTie" | "danglingLink"; partId: string; barId: string; voice: string; beatId: string; noteKey: string }
  | {
      kind: "invalidContent";
      partId?: string;
      barId?: string;
      voice?: string;
      beatId?: string;
      noteKey?: string;
      /** 讀不懂的是哪一層，例如 "bar.timeSig"、"part.kind"、"beat"、"note"（補充） */
      what: string;
    };
```

## 3. 計算

- Flag 只在客戶端計算，不存進文件。
- 每次修改都對整份 `ScoreJSON` 重算。理由：`danglingTie`、`danglingLink` 會跨小節，只算變動的小節會漏；而客戶端每次修改本來就會產生整份 `ScoreJSON`（`ScoreView.vue` 的 `draw`）。
- 只有在 S2 重跑時證明它是瓶頸，才改成增量計算（[`testing.md`](testing.md)）。
- `invalidContent` 由讀取時產生：`readScore` 回傳 `ScoreJSON` 與 `invalidContent` 的清單（`docToJson` 是同一個讀取、只回傳 `ScoreJSON`），和其他 Flag 合併成同一份清單。`what` 的值見 [`schema.md`](schema.md) 第 11 節。
- 順序（補充）：依聲部順序、小節順序、聲線、拍點順序排列；`F8` 依這個順序走。
  - **補充**（#36）：同一個位置上，代表整個聲部、小節或聲線的 Flag 排在它裡面的 Flag 之前（沒有聲部的排最前面，例如 `meta.title`；整小節的 `underfull` 排在那條聲線的拍點之前）；不在 `ScoreJSON` 裡的（被略過的聲部或拍點）排在已知的之後。同一個位置的 Flag 保持找到的順序（排序是穩定的）。

## 4. 顯示

- 時值類的 Flag（`underfull`、`overfull`）在小節上畫框；連結線與連奏的 Flag（`danglingTie`、`danglingLink`）在音符上加標記。
- **補充**：`invalidContent` 有小節時在小節上畫框（和時值類不同的樣式）；只有聲部、沒有小節時（例如整個聲部被略過），只出現在工具列的清單與總數裡。
- 工具列顯示總數；`F8` 或工具列按鈕跳到下一個（到最後一個之後回到第一個，補充）。
  - **補充**（#36）：寫法是 `flags.ts` 的 `nextFlag`。「下一個」是游標之後的第一個 Flag（附加位置算在錨點拍點之後）；游標還停在 `F8` 上次停的地方時，是清單裡那一個的下一個，所以同一個拍點上的兩個 Flag 會依序停到。只停在游標去得了的 Flag：聲部有畫出來（成員隱藏的聲部不算）、小節在團譜裡；沒有聲部或小節的 `invalidContent` 只算進總數。游標停在 Flag 的拍點上，沒有拍點時是那條聲線的第一個位置（聲線不是這個聲部有的就用第一條聲線，沒有小節就用第一小節）；fretted 的音符 Flag 停在那條弦，其他時候留在游標原本的線上（換了聲部時用 `startLine`）。
  - **補充**（#36）：Read view 沒有游標，所以只有總數，沒有「下一個標記」按鈕，`F8` 不動。
  - **補充**（#36）：工具列目前只有總數，還沒有 Flag 的清單；只有聲部、沒有小節的 `invalidContent` 只在總數裡（`__studioTest.flags()` 回傳完整的清單）。
- 三種視圖都顯示。
- 疊層遵守 `ScoreRenderer.reservedRects()`，不得畫進 alphaTab 標記所在的區域（[`views.md`](views.md)）。
- **補充**：Flag 的說明文字（滑鼠移上去或 `F8` 停住時顯示）依種類固定，寫在 `apps/web/src/strings.ts`。
  - **補充**（#36）：目前只有 `F8` 或按鈕停住時，在工具列顯示（游標移開就消失）。疊層不接收滑鼠事件（點擊要落到譜面上），滑鼠移上去顯示還沒有做。
- **補充**（#36）：畫法在 `apps/web/src/overlay.ts` 的 `flagMarksOf`。小節框是那個聲部在那個小節的範圍（和小節範圍的選取框同一個 `boundsOfSelection`），框線畫在矩形內側；音符標記是音符頭（`noteHeadsOf`）外擴一點的填色矩形。兩者都先經過 `clearOf`。只有小節、沒有聲部的 `invalidContent`（例如 `bar.timeSig`）在每個畫出的聲部上畫框。疊層裡每個 Flag 是一個 `<rect data-flag data-kind>`，工具列的總數帶 `data-flag-count` 與 `data-count`，給 e2e 讀。

## 5. 和指令的關係

- 「加上 tie」會把格號設成前一個音的格號，這是指令本身的效果，不是自動修復（[`commands.md`](commands.md) 5.4）。
- 放置樂句時拍號不合，只標 Flag，不改寫。
- 刪除小節、同時輸入造成的超出拍號，只標 Flag。
