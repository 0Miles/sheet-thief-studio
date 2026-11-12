# 譜面引擎用 alphaTab，但只在 `score-render` 裡出現

顯示和播放用 alphaTab：它是唯一同時有 Guitar Pro 等級的 TAB、鼓譜、五線譜和內建合成器的開源方案；VexFlow、OSMD、Verovio 都要自己補排版、TAB 或播放。

alphaTab 有兩個讓我們不想被它綁住的地方：它沒有官方的編輯 API（只能直接改它的模型再整份重排），而且授權正在變動（1.9 起譜面上會顯示它的標記，之後的版本會換成帶署名條款的授權）。所以：

- 團譜的資料格式是我們自己的 schema（ADR 0002），不是 alphaTab 的模型，也不是 alphaTex。
- alphaTab 只在 `packages/score-render` 裡 import。其他程式只認得 `ScoreRenderer`（畫譜、座標查詢）和 `ScorePlayer`（播放）兩個介面。
- 團譜到 alphaTab 模型是單向的投影；游標、選取、編輯指令都以團譜的 id 定址，不依賴 alphaTab 的物件。

## Consequences

- 打譜層（游標、鍵盤輸入、選取）全部要自己做，alphaTab 只負責畫和播。
- 每次編輯都要重新投影並重排；延遲是否可接受由 M0 的量測決定，必要時只重繪游標附近的小節。
- 平台定位是自用，譜面上有 alphaTab 的標記可以接受；不以違反授權的方式移除它。若日後授權變得不能接受，可以固定在舊版，或在介面後面換掉引擎。
