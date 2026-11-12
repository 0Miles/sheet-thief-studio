# 規格附錄

M1a–M5 的規格細節。詞彙見 [`CONTEXT.md`](../../CONTEXT.md)，設計理由見 [`docs/adr/`](../adr/)，里程碑見 [`ROADMAP.md`](../ROADMAP.md)。寫程式之前，先讀和你的票有關的檔案。

標「補充」的地方，是設計對質沒有逐條指定、由 spec 撰寫者保守補上的細節；它們和其他內容一樣是規格，但比較可能被 owner 調整。標「待 owner」或「暫定」的，是等 owner 裁定、目前照暫定預設做的項目。

## 檔案

| 檔案 | 內容 |
|---|---|
| [`schema.md`](schema.md) | 團譜文件的完整形狀：meta、小節、聲部（含 `staves`）、拍點、三種聲部的音符鍵與技巧欄位、長度上限、`schemaVersion`、遷移、讀取時容錯 |
| [`commands.md`](commands.md) | 帶錨點的 Cursor 與附加位置、移動、Selection、每個 Command 的語意（內容操作、結構操作、設定）、放置與貼上、復原、聲部預設表 |
| [`keymap.md`](keymap.md) | 鍵位：總規則、`code` 比對、禁用組合、共通鍵、`Shift`＋字母、三種聲部的輸入鍵（含 18 個鼓件）、面板與文字模式的鍵 |
| [`flags.md`](flags.md) | Flag 的種類、條件、形狀、計算方式與顯示 |
| [`views.md`](views.md) | 三種視圖與判定函式、各視圖能做什麼、顯示選項、Presence 的形狀與顏色、寬度界線與手機版面、`reservedRects` |
| [`accounts.md`](accounts.md) | 帳號與帳號名稱規則、admin 的權限、角色與完整權限表、加入成員、轉移擁有權、離開、唯讀連結、軟刪除、主動斷線的時機 |
| [`collab.md`](collab.md) | 團譜與 Hocuspocus document 的對應、持久化、掛鉤、collab ticket、awareness、斷線與離線、版本的建立、保留、儲存與還原 |
| [`security.md`](security.md) | Cookie、session、Origin、密碼、速率限制、大小上限、回應標頭、CSP、404 規則、log 與部署 |
| [`routes.md`](routes.md) | SPA 路由表、伺服器路由（含 `/auth/karyl`）、依領域分組的 API 大綱、錯誤代碼 |
| [`playback.md`](playback.md) | Mixer、節拍器與預備拍、播放中修改的 (a)／(b)、播放的起點與跟隨、MIDI 聲道分配 |
| [`phrases.md`](phrases.md) | Phrase fragment 的兩種形狀、剪貼簿格式、樂句庫、樂句編輯器的儲存（`baseRevision`、409、413）、樂句側欄、審核頁 |
| [`recognizer.md`](recognizer.md) | 辨識服務：範圍、要複製的模組、授權聲明、HTTP 介面、限制與逾時、契約大綱、#27 的規則與案例、server 這一側與轉換 |
| [`import-export.md`](import-export.md) | 匯入（alphaTab 模型 → `ScoreJSON`）的對照與報告、匯出（GP7、MIDI）、round-trip 測試 |
| [`karyl-login.md`](karyl-login.md) | karyl-chan bot 登入：流程、驗證步驟、設定、綁定、失敗畫面、測試 |
| [`testing.md`](testing.md) | 測試 seam、測試掛鉤與 build、CI 的 job、量測、確認檢查、人工判定項目 |

## 怎麼修改這些文件

- **加法的 schema 欄位**（新增 optional 欄位，不改既有欄位的形狀與語意）：可以在實作的那個 PR 裡直接加，條件是同一個 PR 也改 [`schema.md`](schema.md)、ADR 0002 的增補（形狀有變時）與 `packages/score-model` 的 zod schema。不升 `schemaVersion`，不需要設計會議。
- **非加法的 schema 改動**（改名、改形狀、改語意、刪欄位，也就是要升 `schemaVersion` 並寫遷移）：agent 不得自行決定，要開 `ready-for-human` 票。
- **其他規格**：實作時發現規格有錯或不夠，在同一個 PR 裡修正對應的檔案，並在 PR 說明裡寫出改了什麼、為什麼。改動會推翻 ADR 的，照 `docs/agents/domain.md` 的做法明確指出。
- 改到詞彙時，同時改 [`CONTEXT.md`](../../CONTEXT.md)。
- 以下不得由 agent 自行修改，要開 `ready-for-human` 票：alphaTab 的版本（ADR 0003）、下一節「等待 owner 裁定」的項目。

## 等待 owner 裁定

owner 回答之前，實作照「暫定預設」進行。

1. **樂團成員用哪些桌面作業系統**
   - 暫定預設：只有 Windows、Linux 的鍵位；桌面 Safari 不支援打譜。
   - 如果包含 macOS：鍵位附錄加一欄 Mac 鍵位（[`keymap.md`](keymap.md) 1.3）；如果也要支援桌面 Safari，CI 的 WebKit 加一個打譜的 smoke test，並解決 Safari 在 http 開發環境下對 `__Host-` cookie 的限制；人工判定加上「在各作業系統實際試一次衝突的快捷鍵」。
   - Linux 版 Chrome 的 `Alt+1..8` 是切換分頁；這個預設能不能被頁面擋下，目前沒有證據。
2. **手機能不能上傳圖片辨識**
   - 暫定預設：不能，維持「手機與平板只看譜與播放」。
   - 如果允許：手機上的 `/phrases` 開放「從圖片辨識」，用 `<input accept="image/*">`，可以直接拍照；審核還是在桌面做，手機上的 `/phrases/:id` 與 `/recognitions/:id` 只能看、不能改；辨識結果在伺服器保留最多 7 天，不需要其他改動。
3. **請 owner 確認或否決的產品行為**（都暫定照做）

   | 項目 | 如果否決 |
   |---|---|
   | Owner 轉移擁有權 | 拿掉轉移的 API 與按鈕。Owner 被停用後，團譜就沒有人能管理成員與唯讀連結，除非同時保留下一項 |
   | Admin 轉移停用帳號擁有的團譜 | 拿掉；admin 對團譜沒有任何權限。建議至少保留這一項或上一項 |
   | 軟刪除，30 天內可以還原 | 改成立即永久刪除（連同版本），刪除前用確認對話框；拿掉「已刪除」列表與定時清除的工作 |
   | 節拍器與預備拍 | 拿掉 Mixer 的兩個開關與 `setMetronome`、`setCountIn` |
   | 聲部預設表，以及新團譜的預設值（4/4、120、8 小節） | 依 owner 給的預設表與預設值修改 [`commands.md`](commands.md) 第 10 節；結構不變 |
   | 鍵位總規則：不帶修飾鍵是輸入、`Shift` 是技巧、`Ctrl` 是結構 | 要重新設計整份 [`keymap.md`](keymap.md) |
   | 密碼規則（長度 10–256、沒有組成規則）與登入速率限制（帳號名稱、IP 各自 15 分鐘 10 次） | 只改數字，不改結構 |

4. **S5 播放中修改的預設值**
   - 暫定預設：(a)，停止輸入 400 ms 後重新產生聲音。
   - 如果 owner 試聽後認為那約 0.1 秒的中斷不能接受：把預設改成 (b)，只改一個預設值；兩種行為都已經在範圍內（[`playback.md`](playback.md) 第 3 節）。
   - 試聽步驟見 `docs/spike-report.md` S5 一節的「請你聽一次」。
