# 共編用 Yjs 加 Hocuspocus，團譜本身就是一份 CRDT 文件

團譜要像 Google 文件一樣讓多人同時改同一個小節，而且每個人只復原自己的動作、斷線重連後不丟修改。我們把團譜存成 Yjs 文件（Yjs 13），由 Hocuspocus 伺服器同步；Hocuspocus 和 API 跑在同一個 Node 行程（路徑 `/collab`）。

考慮過、沒採用的做法：

- **伺服器權威的操作序列加每小節後寫者勝**（Figma、tldraw 的做法）。伺服器能在合併前檢查所有規則，但在場、重連重放、個人復原都要自己寫，而且同一小節同時輸入時會有一方的修改被丟掉。
- **Loro、Automerge**。Loro 的移動與歷史功能最強，但同步伺服器和 Vue 的整合都還年輕；Hocuspocus 已經有連線驗證、伺服器強制唯讀、Postgres 持久化。
- **Yjs 14**。還在 RC，用到 move 之後格式只能單向相容；我們的 schema 不需要 move（見 ADR 0002）。
- **Python 後端（pycrdt-websocket）**。成熟度不如 Node 這一側，所以主平台用 TypeScript，辨識服務留在 Python。

## Consequences

- 合併結果不能事後拒絕：規則要靠文件結構保證，不能靠結構的只做標記（Flag），不自動改寫。
- 伺服器要讀寫團譜時，以「伺服器也是一個參與者」的方式開啟文件，不直接改資料庫裡的位元組。
- 文件會隨編輯歷史變大；版本與匯出都走正規化的 JSON（`docToJson`），這也是日後更換共編函式庫的退路。
- 規模變大時，Hocuspocus 可以拆成獨立行程並用 Redis 讓多個行程互相同步；目前不需要。
