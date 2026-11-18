# 量測報告

每個里程碑結尾的重測（[`spec/testing.md`](spec/testing.md) 第 4 節）。M0 的結果在 [`spike-report.md`](spike-report.md)。門檻只是目標，不是 CI 的關卡；量測不在 CI 裡跑。

## M1b

日期：2026-11-18　分支：`hiad-20261116/39-s2-remeasure`（以 `hiad-20261116/studio` `8bce07b` 為底，含 M1b 的全部改動）　票：#39

### 結論

| 項目 | 結果 |
|---|---|
| 門檻 | 按鍵到畫面 p95：一個聲部 ≤ 80 ms、五個聲部 ≤ 150 ms（100 小節 × 5 聲部） |
| Chromium | **達標**。一個聲部最差 61 ms、五個聲部最差 86 ms；另一位成員同時修改時 54 / 89 ms |
| Firefox | **沒達標**（以保守的算法）。一個聲部最差 93 ms（差 13）、五個聲部有技巧的第 3 小節 158 ms（差 8）；同時修改時 96 / 169 ms。改用第一個 frame 算則全部達標（≤ 75 / ≤ 146 ms）。headless Firefox 的 frame 間隔是 31 ms，見「怎麼讀」 |
| WebKit | **沒達標**（以保守的算法），而且數字不完全可信。一個聲部有技巧時最差 88 ms（差 8）、五個聲部 108 ms；同時修改時 90 / 169 ms。Windows 的 Playwright WebKit 沒有 Web Audio（#129），量的是沒有播放器的頁面 |
| `readScore`（zod 驗證 + `WeakMap` 快取） | Chromium 中位數 1.7–2.1 ms，和 M0 的 `docToJson`（1.8 ms）相同；p95 6–8 ms，比 M0（2–3 ms）長 |
| 技巧與 Flag 全部重算 | **不是瓶頸**。`flagsOf` 對整份譜（有技巧的譜 324 個 Flag）Chromium 中位數 0.8–1.2 ms、p95 ≤ 4.5 ms，Firefox / WebKit 中位數 1–3 ms；約占按鍵到畫面的 5% 以內。技巧讓排版變慢（五個聲部第 3 小節 27 → 37 ms），不是 Flag。不建議另開「Flag 改成增量」的票 |
| 時間花在哪 | alphaTab 的排版（`render → rendered`），在 Firefox 約是 Chromium 的 2 倍；以及瀏覽器把畫面送出來的 frame 時序 |

### 環境

| 項目 | 內容 |
|---|---|
| 機器 | Intel Core i9-9900K（8 核 16 緒，3.6 GHz）、128 GB RAM、AMD Radeon RX 9060 XT。桌機，比樂團成員的筆電快 |
| 作業系統 | Windows 11 Pro 10.0.26200（x64） |
| 瀏覽器 | Playwright 1.65.0 附的瀏覽器，全部 headless：Chromium 158.0.8127.18（chrome-headless-shell）、Firefox 159.0（firefox-1572）、WebKit 27.2（webkit-2388）。視窗 1280 × 720，DPR 1（WebKit 也設成 1，不是 Mac 的 2） |
| 計時精度 | `performance.now()` 的最小間隔：Chromium 0.1 ms，Firefox 與 WebKit 1 ms。Firefox / WebKit 的各階段數字因此是整數毫秒，1 ms 以下的階段只能看出「不到 1 ms」 |
| Web Audio | Chromium、Firefox 有；WebKit 沒有（#129） |
| 版本 | Node 24.10.0、pnpm 10.19.0、TypeScript 6.0.3、Vite 8.3.8、Vue 3.5.45、Yjs 13.6.33、Hocuspocus 4.8.0、alphaTab 1.9.0 |
| 量測對象 | 打包後的網頁（`VITE_MEASURE=1` 的 `vite build`），Chromium 與 Firefox 由 `vite preview`（5183）提供，WebKit 由第三個 server 提供（8033，`INSECURE_COOKIES=1`）；server、Postgres、Redis 與 e2e 相同 |
| 負載 | 量測時沒有跑其他重的工作（沒有建置、測試或其他瀏覽器自動化）；桌面上的一般程式還開著。CPU 使用率每分鐘取樣一次，含量測本身在 3–33% 之間 |

三個瀏覽器在同一次執行裡依序量（共 28.8 分鐘）。

### 指令

```
# 全部三個瀏覽器的 S2（結果寫到 docs/measurements/data/）
pnpm --filter @studio/web measure --project=chromium --project=firefox --project=webkit latency

# 只量一個瀏覽器
pnpm --filter @studio/web measure --project=firefox latency

# 開視窗跑（headed）；MEASURE_RUNS=3 只確認套件能跑
HEADED=1 pnpm --filter @studio/web measure --project=firefox latency
MEASURE_RUNS=3 pnpm --filter @studio/web measure --project=webkit latency
```

`--project` 選瀏覽器；`chromium` 跑全部量測，`firefox` 與 `webkit` 只跑 S2（`latency.spec.ts`）。需要 5183、8031、8032、8033 這幾個 port 空著，Postgres 與 Redis 照 e2e 的設定（127.0.0.1:5438 / 6388）。

### 做法

和 M0 的 S2 相同的部分：100 小節 × 5 聲部（Guitar 1、Drums、Keys、Bass、Guitar 2），每小節 8 個八分音符，共 4,000 個拍點；修改 Guitar 1 第 3、50、98 小節第一個拍點的格號；「一個聲部」是成員自己的顯示選項只顯示 Guitar 1。每格 50 次，報中位數與 p95（p95 取第 48 小的值）。編輯視圖用 M0 選的做法（就地換小節、`firstChangedMasterBar`、不用 worker）。

這次的不同：

1. **量的是編輯視圖**（#37），以 admin 登入、開著播放器，和成員實際使用相同。
2. **兩份譜**：`plain` 是 M0 那份；`techniques` 是同樣的音符加上 M1b 的技巧——搥勾弦、滑音（shift、inBelow）、推弦加顫音、點弦、泛音、ghost、staccato、accent、let ring、palm mute、dead、刷弦、slap / pop、每小節開頭的力度、每四小節一個和弦名稱，Keys 每小節一個 tie。其中一部分搥勾弦、滑音與 tie 接不到下一個音，整份譜有 324 個 Flag（`danglingLink`、`danglingTie`）。
3. **各階段多了 `flagsOf`**：`readScore`（讀文件、zod 驗證、`WeakMap` 快取已驗證的拍點）之後，頁面對**整份譜**重算 Flag，這段時間單獨記錄（`RenderSample.flags`）。
4. **另一位成員同時修改**：同一個瀏覽器的另一個 context 以 Editor 帳號開同一份譜（只顯示 Guitar 1），每 250 ms 改一次 Guitar 1 某個小節第一個拍點的格號（小節隨機，避開正在打字的那一小節），實際約每秒 3.6–3.7 次。打字的頁面在每格 50 個按鍵期間收到並畫了 138–152 次（自己的按鍵加對方的修改）。另一個客戶端和打字的頁面在同一台機器上，它自己的排版也占 CPU，所以這是偏悲觀的情況。
5. **按鍵到畫面**：Playwright 送出真的按鍵，間隔 150–650 ms 變動；記錄事件的 `timeStamp`、指令做完、rendered、游標所在小節那一塊畫上去，以及之後第一、第二個 animation frame。和 M0 一樣以**第二個 frame**（frame after）和門檻比較，這比實際多算最多一個 frame。按鍵樣本先依按下的時間排序再去掉前 3 個暖身（#37 審查留下的修正）。

### 數字：按鍵到畫面

毫秒，中位數 / p95，取第二個 frame（frame after）。粗體是超過門檻的 p95。

| 瀏覽器 | 情境 | 顯示 | 第 3 小節 | 第 50 小節 | 第 98 小節 |
|---|---|---|---|---|---|
| Chromium | plain | 1 個聲部 | 39 / 53 | 38 / 53 | 39 / 50 |
| Chromium | plain | 5 個聲部 | 56 / 77 | 44 / 68 | 35 / 55 |
| Chromium | techniques | 1 個聲部 | 41 / 61 | 38 / 59 | 38 / 52 |
| Chromium | techniques | 5 個聲部 | 72 / 86 | 58 / 74 | 38 / 56 |
| Chromium | 同時修改（plain） | 1 個聲部 | 40 / 54 | 36 / 52 | 31 / 53 |
| Chromium | 同時修改（plain） | 5 個聲部 | 65 / 89 | 52 / 79 | 40 / 62 |
| Firefox | plain | 1 個聲部 | 63 / **92** | 61 / 79 | 61 / 78 |
| Firefox | plain | 5 個聲部 | 117 / 139 | 88 / 107 | 62 / 83 |
| Firefox | techniques | 1 個聲部 | 63 / **93** | 62 / **93** | 60 / 78 |
| Firefox | techniques | 5 個聲部 | 135 / **158** | 94 / 123 | 63 / 92 |
| Firefox | 同時修改（plain） | 1 個聲部 | 63 / **92** | 61 / **96** | 62 / **93** |
| Firefox | 同時修改（plain） | 5 個聲部 | 124 / **169** | 89 / **151** | 63 / 114 |
| WebKit | plain | 1 個聲部 | 62 / 76 | 60 / 65 | 54 / 76 |
| WebKit | plain | 5 個聲部 | 92 / 108 | 90 / 108 | 77 / 106 |
| WebKit | techniques | 1 個聲部 | 62 / **83** | 62 / **88** | 61 / 77 |
| WebKit | techniques | 5 個聲部 | 93 / 108 | 78 / 105 | 67 / 92 |
| WebKit | 同時修改（plain） | 1 個聲部 | 62 / **90** | 62 / 77 | 60 / 77 |
| WebKit | 同時修改（plain） | 5 個聲部 | 100 / **151** | 108 / **169** | 94 / 139 |

每一格的 50 個按鍵都等到了重畫，沒有丟掉任何樣本。完整的表（handler 開始、指令做完、rendered、小節畫上去、第一個 frame）在 [`s2-keys-*-headless.md`](measurements/data/) 與 [`s2-concurrent-*-headless.md`](measurements/data/)。

**和門檻比較**（p95 的最差值，取第二個 frame；括號內是取第一個 frame）

| 瀏覽器 | 一個聲部（≤ 80） | 五個聲部（≤ 150） | 同時修改：一個 / 五個聲部 |
|---|---|---|---|
| Chromium | 61（45）達標 | 86（69）達標 | 54（40）/ 89（74）達標 |
| Firefox | 93（75）沒達標 | 158（128）沒達標 | 96（62）/ 169（146）沒達標 |
| WebKit（無播放器） | 88（63）沒達標 | 108（93）達標 | 90（70）/ 169（122）沒達標 |

### 數字：各階段

毫秒，中位數 / p95，每次修改之間停 120 ms。Chromium（0.1 ms 精度）：

| 譜 | 顯示 | 小節 | `readScore` | `flagsOf` | 投影 | `finish()` | 排版到 rendered | 合計 |
|---|---|---|---|---|---|---|---|---|
| plain | 1 | 3 | 1.8 / 6.8 | 0.8 / 2.6 | 0.2 / 0.6 | 0.0 / 0.1 | 4.5 / 9.9 | 7.4 / 19.8 |
| plain | 1 | 50 | 1.7 / 6.8 | 0.8 / 2.6 | 0.2 / 0.5 | 0.0 / 0.1 | 2.1 / 5.6 | 5.0 / 15.6 |
| plain | 1 | 98 | 1.9 / 7.7 | 0.8 / 2.8 | 0.2 / 0.6 | 0.0 / 0.1 | 0.6 / 1.5 | 3.4 / 12.9 |
| plain | 5 | 3 | 1.8 / 7.5 | 0.8 / 2.8 | 0.2 / 0.5 | 0.0 / 0.1 | 27.0 / 41.8 | 30.1 / 50.2 |
| plain | 5 | 50 | 1.7 / 7.6 | 0.8 / 2.6 | 0.2 / 0.6 | 0.0 / 0.1 | 12.5 / 21.4 | 15.0 / 30.8 |
| plain | 5 | 98 | 1.7 / 6.6 | 0.8 / 2.3 | 0.2 / 0.5 | 0.0 / 0.1 | 1.6 / 3.7 | 4.3 / 13.2 |
| techniques | 1 | 3 | 1.8 / 7.4 | 1.2 / 4.0 | 0.2 / 0.6 | 0.0 / 0.1 | 7.1 / 14.5 | 10.8 / 27.5 |
| techniques | 1 | 50 | 1.7 / 6.5 | 1.2 / 3.6 | 0.3 / 0.7 | 0.0 / 0.2 | 3.6 / 8.5 | 7.2 / 19.7 |
| techniques | 1 | 98 | 1.8 / 7.5 | 1.2 / 4.0 | 0.2 / 0.5 | 0.0 / 0.1 | 0.7 / 1.6 | 4.4 / 15.0 |
| techniques | 5 | 3 | 2.1 / 7.6 | 1.2 / 4.5 | 0.3 / 0.6 | 0.0 / 0.2 | 36.8 / 49.4 | 41.0 / 62.1 |
| techniques | 5 | 50 | 1.8 / 6.8 | 1.2 / 3.6 | 0.2 / 0.6 | 0.0 / 0.1 | 16.2 / 29.5 | 20.4 / 39.8 |
| techniques | 5 | 98 | 1.8 / 6.3 | 1.1 / 3.5 | 0.2 / 0.5 | 0.0 / 0.1 | 2.0 / 4.5 | 6.0 / 15.1 |

Firefox 與 WebKit 摘要（1 ms 精度，全部 12 格的範圍）：

| 瀏覽器 | `readScore` 中位數 / p95 | `flagsOf` 中位數 / p95 | 排版到 rendered：五個聲部第 3 小節（plain / techniques） | 合計最差 p95 |
|---|---|---|---|---|
| Firefox | 2–3 / 6–10 | 2–3 / 3–12 | 57 / 71、80 / 94 | 109 |
| WebKit | 3 / 6–9 | 1–2 / 3–6 | 23 / 35、32 / 41 | 55 |

完整的表在 [`s2-stages-*-headless.md`](measurements/data/)。

### 怎麼讀這些數字

- **`docToJson` 加 zod 驗證與 `WeakMap` 快取**（現在是 `readScore`）：中位數和 M0 沒有驗證時的 `docToJson` 一樣（1.8 ms），快取讓每次修改只重新驗證改到的那一小節。p95 從 M0 的 2–3 ms 變成 6–8 ms，多出來的 4–5 ms 在三個瀏覽器都看得到；可能是回收記憶體或快取失效的那幾次，這次沒有追。和門檻比起來不大。
- **Flag 全部重算不是瓶頸**：每次修改都對整份譜重算 Flag，Chromium 0.8 ms（沒有 Flag）到 1.2 ms（324 個 Flag），p95 ≤ 4.5 ms；Firefox 與 WebKit 中位數 1–3 ms。按鍵到畫面的中位數是 35–135 ms，`flagsOf` 約占 5% 以內；就算降到 0，也不會讓任何一格從沒達標變成達標（最接近的是 Firefox 五個聲部技巧譜第 3 小節，差 8 ms，而那格的 `flagsOf` 中位數 2 ms）。依 `spec/testing.md`「只有證明是瓶頸時，才把 Flag 改成增量計算」，**不開**改成增量的票。
- **技巧的成本在排版**：同樣的修改，技巧譜比 plain 譜的排版多 30–60%（Chromium 五個聲部第 3 小節 27.0 → 36.8 ms，Firefox 57 → 80 ms）；投影只多 0.1 ms。
- **另一位成員同時修改**：在 Chromium 讓 p95 多 0–12 ms（五個聲部第 3 小節 77 → 89 ms），仍在門檻內；在 Firefox 與 WebKit 讓五個聲部的 p95 多 30–60 ms（Firefox 第 3 小節 139 → 169 ms、WebKit 第 50 小節 108 → 169 ms）。原因是按鍵碰上剛開始的對方修改的排版，要等它做完；五個聲部時「handler 開始」的 p95 從 1 ms 變成 10–25 ms（Chromium / WebKit）就是這件事。對方的客戶端也在同一台機器上排版，會比真實情況更糟。
- **瀏覽器的 frame 時序占了很大一塊**：
  - headless Firefox 的 animation frame 間隔中位數是 **31 ms**（約 32 Hz），不是 60 Hz 的 16.7 ms。以第二個 frame 算時，等兩個 frame 就固定多出 30–60 ms；Firefox 的 frame after 中位數幾乎都落在 61–63 ms 也是這個原因。開視窗的 Firefox 在 60 Hz 螢幕上很可能會好上一截，但**這次沒有量**。
  - WebKit（Windows 的 Playwright 版本）在小節畫上去之後，第一個 frame 要再等中位數 **28 ms**（Chromium 5 ms、Firefox 8 ms），frame 間隔則是 16 ms。這比較像 Windows 版 WebKit 的繪製排程，不一定代表 Mac 上的 Safari。
- **Firefox 的排版約是 Chromium 的 2 倍**（五個聲部第 3 小節 57 vs 27 ms，技巧譜 80 vs 37 ms），這部分和 frame 時序無關。如果開視窗量之後 Firefox 仍然沒達標，第一個要動的就是這裡：M0 報告提過的「只畫游標附近的小節」。
- **WebKit 的數字只能當參考**：
  - 頁面沒有 Web Audio，alphaTab 的播放器永遠不會 ready，修改後 400 ms 重新產生聲音的那一步（`player.load()`）什麼都不做，所以 WebKit 少了 Chromium / Firefox 有的那份負擔（M0 量過是 9–15 ms，在按鍵之間發生）。
  - 這是 Windows 上的 WebKit，不是 macOS 的 Safari：圖形後端、frame 排程與 JIT 設定都不同，`navigator.hardwareConcurrency` 只回報 8。
  - DPR 設成 1；Mac 的 Retina 螢幕是 2，繪製量是四倍，這次沒有量。
- **和 M0 比較（Chromium）**：M0 的 `replace+hint, no worker` 一個聲部 p95 39–44 ms、五個聲部 39–67 ms；這次 plain 譜 50–53 / 55–77 ms。多出的 10 ms 左右來自編輯視圖本身（`readScore` 的 p95、`flagsOf`、游標與 presence 的重畫、播放器），和 M0 用的鷹架頁不同；排版本身（27.0 vs 27.3 ms）沒有變。

### 需要人做的事

- 在 60 Hz（或更高）的螢幕上開視窗量 Firefox，確認沒達標是否來自 headless 的 32 Hz frame：
  `HEADED=1 pnpm --filter @studio/web measure --project=firefox latency`
  （會開瀏覽器視窗約 11 分鐘；結果寫成 `s2-*-firefox-headed.*`）
- WebKit 的可信數字要在 macOS 的 Safari（或有 Web Audio 的 Linux WebKit）上量：在 Mac 上 `pnpm --filter @studio/web measure --project=webkit latency`。在 Windows 上沒有辦法補上 Web Audio（#129）。

### 資料檔

[`measurements/data/`](measurements/data/)：每個瀏覽器三組，`s2-stages-<瀏覽器>-headless`、`s2-keys-<瀏覽器>-headless`、`s2-concurrent-<瀏覽器>-headless`，`.json` 是每個樣本與環境，`.md` 是表。
