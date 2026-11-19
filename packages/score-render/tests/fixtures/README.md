# 匯入匯出的樣本

`importExport.test.ts` 的 round-trip 樣本（`docs/spec/import-export.md` 第 4 節）。都由這個 repo 自己產生，不從網路下載。

| 檔案 | 怎麼來的 |
|---|---|
| `round-trip.gp` | `samples.ts` 的 `GP7_SAMPLE` 用 `exportGp7` 匯出。改了樣本之後重寫：在 `packages/score-render` 下執行 `WRITE_FIXTURES=1 pnpm vitest run tests/importExport.test.ts -t "writes"` |
| `round-trip.gp5` | `make_round_trip_gp5.py` 以 PyGuitarPro 0.9 寫出一次。執行：`python -I -B make_round_trip_gp5.py round-trip.gp5`（需要 `pip install PyGuitarPro==0.9.3`；#69 用的是前身 repo 已有的虛擬環境，沒有在這台機器另外安裝） |
| `round-trip.musicxml` | 手寫 |

三份都有三種聲部、技巧、反覆與跳房子、段落、拍號的改變、歌詞；GP7 與 GP5 另外有速度與調號的改變。GP5 與 MusicXML 另外有 Segno、Coda、D.S. al Coda，用來確認匯入報告會列出它們。
