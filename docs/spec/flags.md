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
- 要修改 `flags.ts` 的 `flagsOf`：加上弱起的例外。
- **「前一個音」**（補充）：同一聲部、同一條聲線裡，緊接在前的那個拍點（可以是上一個小節同一條聲線的最後一個拍點）上，同一個音符鍵的音。前一個拍點是休止或沒有那個鍵，就是不存在。
- **「下一個音」**（補充）：同一聲部、同一條聲線裡，緊接在後的那個拍點（可以是下一個小節同一條聲線的第一個拍點）上，同一條弦的音。
- 拍點之間的「緊接」只看同一條聲線；另一條聲線或另一個聲部的音不算。
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

## 4. 顯示

- 時值類的 Flag（`underfull`、`overfull`）在小節上畫框；連結類的 Flag（`danglingTie`、`danglingLink`）在音符上加標記。
- **補充**：`invalidContent` 有小節時在小節上畫框（和時值類不同的樣式）；只有聲部、沒有小節時（例如整個聲部被略過），只出現在工具列的清單與總數裡。
- 工具列顯示總數；`F8` 或工具列按鈕跳到下一個（到最後一個之後回到第一個，補充）。
- 三種視圖都顯示。
- 疊層遵守 `ScoreRenderer.reservedRects()`，不得畫進 alphaTab 標記所在的區域（[`views.md`](views.md)）。
- **補充**：Flag 的說明文字（滑鼠移上去或 `F8` 停住時顯示）依種類固定，寫在 `apps/web/src/strings.ts`。

## 5. 和指令的關係

- 「加上 tie」會把格號設成前一個音的格號，這是指令本身的效果，不是自動修復（[`commands.md`](commands.md) 5.4）。
- 放置樂句時拍號不合，只標 Flag，不改寫。
- 刪除小節、同時輸入造成的超出拍號，只標 Flag。
