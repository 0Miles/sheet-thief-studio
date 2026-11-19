# 播放、混音、MIDI 聲道

標「補充」的是 spec 撰寫者保守補上的細節。

## 1. Mixer（混音）

Mixer 只存在每個成員的本機（localStorage），不屬於團譜（`CONTEXT.md`、`types.ts:72-75`）。

| 設定 | 範圍 | 存在哪裡（補充） |
|---|---|---|
| 各聲部的靜音、獨奏、音量 | 音量 0–1，1 是團譜寫的音量（`ScorePlayer.setVolume`） | 每份團譜一份：`studio.mixer.<scoreId>`，以聲部 id 為鍵 |
| 播放速度 | 補充：0.25–1.5，間隔 0.05；1 是團譜的速度 | 同上 |
| 循環 | 由選取範圍決定，不存 | — |
| 節拍器開關 | 開／關 | 全站共用：`studio.playback` |
| 預備拍（一小節）開關 | 開／關 | 全站共用 |
| 播放中修改的行為 | (a) 或 (b)，見第 3 節 | 全站共用 |

- owner 在 2026-11-13 確認保留節拍器與預備拍（[`README.md`](README.md) 的「owner 的裁定」）。
- 窄螢幕的 Read view，混音面板收在抽屜裡（[`views.md`](views.md)）。
- 訪客也可以用 Mixer（本機設定，不影響任何人）。
- **補充**（#33）：實作在 `apps/web/src/mixer.ts`。`studio.mixer.<scoreId>` 的值是 `{ parts: { [partId]: { mute, solo, volume } }, speed }`；和團譜寫的一樣（不靜音、不獨奏、音量 1）的聲部不寫進去；被刪掉的聲部保留它的紀錄，復原刪除時混音跟著回來。`studio.playback` 的值是 `{ metronome, countIn, whilePlaying: "a" | "b" }`。讀不懂的值當成預設（聲部照團譜、速度 1、節拍器與預備拍關、(a)）。
- **補充**（#33）：介面：編輯視圖與寬版 Read view 是工具列的「混音」按鈕打開的側邊面板（和小節屬性、聲部面板一樣，一次只開一個）；窄螢幕 Read view 在抽屜裡（縮放的下面）。面板列出各聲部的靜音、獨奏、音量（0–100%，間隔 5%）、播放速度、循環（編輯視圖顯示目前選取的小節；Read view 沒有這一列）、節拍器、預備拍、播放中修改的行為。
- **補充**（#33）：和其他聲部共用聲道的聲部（兩個以上的鼓聲部；超過 15 個非鼓聲部時第 15 個以後的）在名稱旁標 `*`，面板下方說明「靜音、獨奏與音量會一起作用在那些聲部上」。共用與否由 score-render 的 `sharesChannels`（用 `channelsOf`）決定，殼不自己算聲道。

## 2. `ScorePlayer` 的增補

- `setMetronome(on: boolean)`：對應 alphaTab 的 `metronomeVolume`（`AlphaTabApiBase`，`alphaTab.d.ts:1118-1150`；預設關閉）。**補充**：開是 1，關是 0。
- `setCountIn(on: boolean)`：對應 `countInVolume`（同上；預設關閉）。**補充**：開是 1，關是 0。
- **補充**（#129、#132）：`ScorePlayer.state` 是 `"loading" | "paused" | "playing" | "failed" | "unavailable"`。`"unavailable"` 只出現在瀏覽器沒有 Web Audio 時，建立時就是這個值、之後不變（不會經過 `onState`，殼建好引擎要先讀一次 `state`）；`"failed"` 是音色檔拿不到，`ScorePlayer.retry()` 重新下載；細節都見 4.1。能不能按播放、停止由 score-render 的 `playerUsable(state)` 判斷（paused 或 playing），殼不自己列狀態。
- 預備拍是一小節；從游標小節開始播放時，預備拍用不用起點小節的拍號，由人工試聽判定（[`testing.md`](testing.md) 的人工項目）。

## 3. 播放中修改

兩種行為都做，用 Mixer 的本機設定切換。

| 模式 | 行為 |
|---|---|
| **(a)**（預設） | 停止輸入 400 ms 後重新產生聲音（`apps/web/src/sound.ts` 的 `SOUND_DELAY`）；播放會中斷約 75–117 ms（`spike-report.md:258`），然後從原位置接著播 |
| **(b)** | 播放中不呼叫 `player.load()`；在暫停、停止、或循環回頭（播放位置倒退）時才呼叫，並顯示「播放的是修改前的內容」 |

- **補充**（#33）：「何時呼叫 `load()`」是 `apps/web/src/sound.ts` 的 `soundUpdates`（`SOUND_DELAY` 也在那裡），用假的 `ScorePlayer` 與假時鐘在 `apps/web/tests/sound.test.ts` 測試。細節：
  - (b) 在暫停中的修改，和 (a) 一樣 400 ms 後產生聲音；400 ms 到時已經在播放，就改成等暫停、停止或倒退。
  - 「倒退」是播放中回報的位置比上一次小（循環回頭、往回跳）。停止在播放器看來也是 paused，一樣算一次。
  - 結構操作是新模型，alphaTab 自己重新產生整份聲音，(a)、(b) 都一樣；之前等著的內容修改也包含在裡面，提示跟著消失。
  - 播放中從 (b) 換成 (a)：等著的修改 400 ms 後產生；從 (a) 換成 (b)：播放中就改成等。
- **補充**（#33）：聲音換好之後，播放回到的是**音樂上的同一個位置**（小節 id、第幾次播到、小節內的 tick），不是同一個 tick：設反覆、改拍號、在前面插入小節都會讓之後的小節換到別的 tick。這段期間殼讀到的 `position` 也已經換成新聲音的 tick（新模型的 tick lookup 在拿到模型時就建好了）。那個小節不在了，才退回原來的 tick。產生期間成員跳到別處（`seek`、停止），就以那裡為準。聲音換好、跳回去的同時，`position` 就是新的位置，不等 alphaTab 回報；停止也一樣，`position` 立刻是循環的起點（沒有循環就是 0）。
- 預設 (a)。是否改成 (b)，由人工試聽判定，不擋其他票。試聽步驟見人工判定票 #41（`docs/spike-report.md` S5 一節的「請你聽一次」是 M0 當時在 `/local` 上的做法，#37 已移除那一頁）。
- **補充**：「修改」包含自己的與其他成員送來的修改，規則相同。
- 編輯視圖用「就地換小節」：alphaTab 看到的是同一份 `Score`，不會每次按鍵都自己重新產生聲音並停止播放（ADR 0003，`spike-report.md` S5）。
- alphaTab 1.9 的 `loadMidiForScore()` 會讓播放器停下來並回到開頭，所以 `load()` 記下當時的 tick 與是否在播放，重新產生後跳回那個 tick 再播放（`spike-report.md` S5）。
- 監聽器只在建構時訂閱一次，不在處理函式裡再訂閱或再呼叫 `loadMidiForScore()`（`alphaTabEngine.ts:105-107`）。

## 4. 播放的起點、循環與跟隨

| 視圖 | 點譜面 | 播放的起點 | 循環 | 自動跟隨 |
|---|---|---|---|---|
| 可編輯視圖、唯讀編輯視圖 | 只移動 Cursor（`enableSeekToClick = false`、`enablePlaybackRangeSelection = false`） | Cursor 所在小節的開頭 | 有選取時，以選取範圍當循環區間 | 成員按鍵或手動捲動時暫停，直到下一次按播放 |
| Read view | 移動播放位置（補充：不自動開始播放） | 目前的播放位置 | 沒有選取，所以沒有循環（補充） | 一直跟隨 |

- 循環區間（補充）：拍點範圍是「第一個拍點的起點 tick」到「最後一個拍點的結束 tick」；小節範圍是第一個小節的開頭到最後一個小節的結尾。
  - **補充**（#33）：`ScorePlayer.loopOf(selection)` 依目前的聲音算出這個區間（有反覆時取第一次播到的位置；第一次聲音產生前是 null）。殼在選取改變、每次排版完成、每次 `load()` 完成後重新算，交給 `setLoop`；沒有選取就是 `setLoop(null)`。一樣的區間再設一次什麼都不做。
  - **補充**（#33）：設了新的循環，原本在區間內的播放位置不動，在區間外的移到較近的一端（alphaTab 自己會跳到起點，引擎再跳回來）；`seek` 一律夾在區間內，停止回到區間的起點。播放的起點仍是游標所在小節的開頭，夾在區間內；游標通常是選取的 focus，也就是區間的一端。
  - **補充**（#33）：alphaTab 在循環結尾先回報到達（或超過）結尾的位置才跳回起點；引擎把這種位置當成區間的最後一個 tick，工具列不會閃過區間後面的小節。alphaTab 的 worker 每次換新聲音都會忘掉循環（`MidiFileSequencer.loadMidi` 換掉整個狀態），引擎在每次 midiLoaded 時重新給一次。
  - **補充**（#33 審查）：新聲音的 tick 可能移動（設反覆、改拍號），而殼重算循環（排版完成時）與 midiLoaded 誰先到不一定。引擎記住循環在音樂上的起點與最後一個 tick（和播放位置一樣，以小節 id、第幾次、小節內偏移表示），midiLoaded 時用新聲音的 tick 換算，再送給 alphaTab、再把播放位置夾進去；殼之後再設同一個區間就什麼都不做。殼若已經在新聲音的 tick 下設過，就不換算。兩種先後都在 `engine.test.ts` 測。
- 跟隨由殼自己做：`ScoreRenderer` 有「由播放位置（tick）查座標」的方法 `boundsAtTick`（alphaTab 的捲動已經關掉，`alphaTabEngine.ts` 的 `ScrollMode.Off`；見 4.1）。
- **補充**：`Space` 是播放／暫停（[`keymap.md`](keymap.md)）。
- iOS 第一次播放要在使用者的手勢裡啟動音訊；實機確認是人工項目。

### 4.1 編輯視圖的播放（#31）

- 介面：`ScoreRenderer.boundsAtTick(tick)` 回傳那個 tick 正在播的拍點，高度是它所在的整個 system（`MasterBarBounds.realBounds`）；在小節的起點，就是游標停在那個小節空聲線附加位置時的左緣。`ScorePlayer.tickOf(barId)`、`barAt(tick)` 在小節與 tick 之間換算，`onFinished` 在播到譜尾、停下來時呼叫（循環的結尾不算）。這些都讀 alphaTab 產生聲音時建的 tick lookup，所以有反覆記號時，小節是照它「聽起來」的位置找；三者在第一次的聲音產生前回傳 null。拍點則從目前的排版找，所以剛改過、聲音還沒重新產生的小節也畫得出來。
- **補充**：換新模型時，alphaTab 在拿到模型的同時就建好新的 tick lookup（聲音由 worker 之後才產生），所以第一次的聲音產生之後，`tickOf`、`barAt` 不會再回傳 null。
- **補充**：播放位置由殼畫在疊層裡（`data-playhead`），和其他疊層一樣避開保留區域；alphaTab 自己的播放游標關掉（`enableCursor = false`）。
- **補充**：工具列有「播放／暫停」（同一個按鈕）、「停止」，載入音色時顯示「音色載入中…」，播放或暫停中顯示「第 N 小節」（小節序號從 1 起算，`data-bar`）。按完工具列的按鈕，鍵盤焦點回到譜面。
- **補充**（#129）：瀏覽器沒有 alphaTab 1.9 建播放器需要的東西時（沒有 `Worker`、沒有 `AudioContext`／`webkitAudioContext`，或既沒有 `ScriptProcessorNode`、也不是「安全來源加 `AudioWorkletNode`」；輸出節點的條件照 alphaTab 的 `createWorkerPlayer`；`Worker` 與 audio context 是多檢查的兩項，少了它們 alphaTab 也會失敗，只是較晚、而且記錯誤，所以判斷結果一致；`alphaTabEngine.ts` 的 `canPlaySound`，升 alphaTab 版本時要重新核對），引擎不交給 alphaTab 建播放器（`PlayerMode.Disabled`，alphaTab 因此不記錯誤），`ScorePlayer.state` 從一開始就是 `"unavailable"`，之後不變；`load()` 立即完成，播放、暫停、停止、跳位都不做事。譜面照常畫、照常打譜。工具列（編輯視圖與 Read view）的「播放」「停止」停用，顯示「這個瀏覽器無法播放聲音」（`data-player="unavailable"`）。真實的 Safari、Chrome、Firefox 都有 Web Audio；目前碰得到的是 Windows 上的 Playwright WebKit。樂句預覽本來就不建播放器（`soundFont: null`，第 7 節），不受影響。
- **補充**（#132）：音色檔拿不到時（下載中途斷網、伺服器回錯誤狀態、或內容讀不懂；alphaTab 1.9 三種都只由播放器的 `soundFontLoadFailed` 回報，API 當成 error，而且自己不會再試），`ScorePlayer.state` 變成 `"failed"`，工具列顯示「音色載入失敗」（`data-player="failed"`），「播放」按鈕換成「重試」，「停止」停用。「重試」用播放按鈕本身、不另加按鈕，狀態文字也不比「音色載入中…」寬，所以和其他狀態一樣不改變工具列的寬度（#67：播放、暫停、停止、失敗都不能讓 1280 px 的工具列換行、譜面位移；`PlayerControls.vue` 狀態欄的 `min-width: 6.5em` 放得下「音色載入中…」「音色載入失敗」「第 1000 小節」）。重新下載有兩個時機：成員按「重試」（`ScorePlayer.retry()`），或瀏覽器回到線上（引擎自己聽 `window` 的 `online`）；期間狀態回到 `"loading"`，拿到後進入 paused，再失敗就回到 `"failed"`，次數不限。`"failed"` 以外的狀態 `retry()` 不做事。下載中（`"loading"`）就回到線上、失敗的回報才到時（斷網的失敗可能比 `online` 晚到），進入 `"failed"` 的同時立刻重試一次，不必等下一次回到線上；只補這一次，不會因為一直失敗而一直重試。引擎 `destroy()` 之後，worker 再回報什麼都不通知殼。音色還沒好（載入中或失敗）期間就地修改的小節，播放器就緒時引擎再產生一次聲音，不會播出修改前的內容。e2e 在 `playback.spec.ts`，用 `page.route` 讓下載中斷。
  - 不在範圍內（#151）：譜面那一側的資源（音樂字型、alphaTab 的 worker 腳本）同樣在下載失敗後不會再試，但 alphaTab 1.9 不回報、也沒有公開的重試方法（字型登記在頁面層級的靜態表裡，worker 沒有 error 監聽），要另外設計。
- **補充**：暫停之後再按播放，游標沒有移動過就從暫停的地方接著播；游標移動過（包含被別人的修改移動）就從游標所在小節的開頭播。停止之後一律從游標所在小節開始，工具列不再顯示小節。
- **補充**：跟隨：正在播的拍點所在的 system 沒有整個在畫面上時，捲到它上方留 40 px 的位置。「手動捲動」是頁面自己沒有做的任何捲動（滾輪、觸控、捲軸、鍵盤都算）：殼記下自己捲到的位置，`scroll` 事件停在別的位置就是成員捲的；但譜面變短或檢視變高、瀏覽器把位置拉回能捲到的範圍內（停在最底端）時，不算手動捲動，殼改記這個位置。macOS 的捲軸疊在內容上、不佔版面，從點擊的位置分不出來，所以不看點擊。譜面關掉 scroll anchoring（`overflow-anchor: none`），排版改變時瀏覽器不會自己捲。點譜面不算（播放中點譜面只移動游標，畫面不跟著游標捲動）。
- **補充**：(a) 的計時只算內容操作（`patchBars`）；結構操作會換一份新的 alphaTab 模型，alphaTab 自己重新產生聲音。內容操作沒辦法就地換小節、改成整份重新投影時也一樣；這時 `load()` 不再產生第二次，只等 alphaTab 那一次完成。
- **補充**：alphaTab 每次重新產生聲音都會停下來、回到開頭，worker 依序回報：位置 0、paused、ready、midiLoaded、再一次 ready、位置 0（alphaTab 1.9 的 `AlphaSynth.loadMidiFile`，以及頁面這一側收到 midiLoaded 時先檢查 ready）。引擎的做法：
  - 從開始產生到 midiLoaded 之間的回報都不算播放；`playerReady` 只有第一次算數。midiLoaded 之後跳回原來的位置，成員要播就接著播；最後那個位置 0 早於跳回的位置，也不算。所以播放中改譜，殼看到的狀態一直是 playing，位置也不會回到開頭。
  - alphaTab 自己的狀態與位置（`playerState`、`tickPosition`）都是 worker 回報的快取，會晚到；引擎自己記成員最後要的是播還是不播，以及送去的位置（跳位、停止、聲音換好後跳回），在 alphaTab 從那裡回報之前以它為準。所以剛按的暫停還沒回報就開始重新產生聲音，也不會又播起來；聲音換好、還沒回報 playing 時又要重新產生，也會從同一個位置接著播。
  - 不論在播放還是暫停，聲音換好之後都跳回原來的位置；所以暫停中改了小節，工具列的小節和下一次播放的起點都不變。聲音產生期間按暫停或停止，就不再接著播（停止也回到開頭）；按播放或跳到別的位置，就在聲音換好之後從那裡播。
  - 同時有幾個聲音在產生（例如一次換新模型、一次 `load()`），等最後一個 midiLoaded 才算完成。
  - worker 拿不到新的聲音時（alphaTab 1.9 依序回報位置 0、paused、ready，再由播放器回報 `midiLoadFailed`；API 只把它當成 error），這次產生也算結束，和 midiLoaded 一樣跳回原來的位置，不會一直等下去。
  - `load()` 遇到還在等排版的內容操作（前一次排版還沒完成，這次的改動還沒進模型）時，等它進了模型才產生聲音；promise 在那次聲音換好時才 settle。

## 5. MIDI 聲道

分配規則（#25 實作在 `packages/score-render/src/channels.ts` 的 `channelsOf`，投影的 `projectScore` 用它）：

1. 依聲部順序，先給每個非鼓聲部一個獨立的**主聲道**（第 9 聲道除外），最多 15 個。
2. 剩下的聲道當**副聲道**，依聲部順序分配給非鼓聲部。
3. 分不到副聲道的聲部，副聲道就用主聲道。代價：同一聲部裡推弦的那個音，會影響同時發聲的其他音。
4. 所有鼓聲部共用第 9 聲道（第 10 個 MIDI 聲道），主副聲道都是 9，program 是 0。

- 理由：現在超過 7 個聲部時會共用聲道，program 互相覆蓋（音色錯掉），混音的靜音、獨奏也會互相影響。
- 聲道從 0 起算，共 16 個（0–15）。
- 例子：3 個非鼓聲部加 1 個鼓 → 主聲道 0、1、2；副聲道 3、4、5；鼓 9。15 個非鼓聲部 → 主聲道 0–8、10–15，副聲道都等於主聲道。
- **補充**：同時新增聲部讓非鼓聲部超過 15 個時（指令擋不住同時的修改），超出的聲部共用第 15 個非鼓聲部的聲道，不丟例外。
- **補充**（#25）：「超出的聲部共用第 15 個非鼓聲部的聲道」是主、副聲道都用 15（此時第 15 個非鼓聲部的副聲道已經等於主聲道）。共用聲道的聲部，program 以 alphaTab 送出的最後一個為準，靜音、獨奏也互相影響；這是超過上限的代價，「新增聲部」在超過上限時停用，成員刪掉多的聲部就恢復。
- **補充**（#25）：分配只看聲部依 `order`（同鍵再依 id）排好的種類序列，不看本機狀態，所以共編的每一方從同一份文件算出同樣的聲道。鼓聲部不論排在哪裡都不佔非鼓聲部的聲道。0 個聲部時沒有聲道（引擎本來就不產生 MIDI，`drawNothing`）。
- **補充**（#25）：alphaTab 只在副聲道上播需要推弦、搖桿或抖音的音（`MidiFileGenerator` 的 `_needsSecondaryChannel`），program 在主、副聲道各送一次；聲道在投影時寫進 `Track.playbackInfo`，alphaTab 的 `ModelUtils.consolidate` 只在匯入時跑，不會改寫它們。新增、刪除、移動聲部都是結構操作，整份重投影，聲道跟著重算。
- **補充**（#33）：混音（靜音、獨奏、音量）在引擎裡以聲部 id 為鍵保存，殼也以聲部 id 存在本機；alphaTab 的是以聲道為鍵，而且 worker 在 `loadMidiFile` 時不清掉。所以每次 midiLoaded（新模型或 `load()`）、每次播放器就緒（`playerReady`），與每次修改混音時，引擎先 `resetChannelStates`，再依**現在**各聲部的聲道一個一個聲道設定（`channels.ts` 的 `channelMixOf`）：共用一個聲道的聲部，任何一個靜音就靜音、任何一個獨奏就獨奏、音量取最小的。結果和設定的先後無關。`resetChannelStates` 也會清掉各聲道的移調，投影沒有寫移調，所以沒有影響。混音在聲部還沒畫出來、或 0 個小節／0 個聲部時照樣記著，有了再套用；`resetChannelStates` 不清音量，所以每個用到的聲道都重設音量（沒設定的是 1）。測試在 `engine.test.ts`：新增一個聲部讓其他聲部的聲道移位後，靜音、獨奏、音量仍在原來的聲部上。
- **補充**（#152）：alphaTab 1.9 每次播放器就緒（`readyForPlayback`，每次產生聲音都在 midiLoaded 之後再來一次，音色到的時候也有）都會用每個 track 的預設音量（`playbackInfo.volume / 16`）呼叫 `setChannelVolume`，蓋掉成員的音量。alphaTab 自己的這個監聽器比引擎的早註冊（`_setupPlayerWrapper`），而 `api.playerReady` 就是同一個事件，所以引擎在自己的 `playerReady` 裡每一次都重新套用混音，最後送到 worker 的一定是成員的值。`engine.test.ts` 的替身照 alphaTab 的做法在就緒時設預設音量。監聽器的先後只有真的 alphaTab 能證明，所以 `apps/web/e2e/mixer.spec.ts` 另外記錄頁面實際送給合成 worker 的訊息（包住 `Worker.prototype.postMessage`）：設過音量的團譜重新開啟後，每個聲道最後一則 `setChannelVolume` 是成員的值（沒設定的是 1），不是 15/16。
- 這條規則用 `packages/score-render/tests/sound.test.ts` 同一種寫法測試：16 個聲部（其中 15 個非鼓）都拿到獨立的主聲道，鼓都在第 9 聲道；副聲道、各聲道的 program、兩份 `Y.Doc` 同時新增到超過上限也在那裡。分配函式本身在 `packages/score-render/tests/channels.test.ts`。

## 6. 上限

- 聲部總共最多 16 個，其中非鼓聲部最多 15 個：16 個 MIDI 聲道扣掉鼓的第 9 聲道，剛好讓每個非鼓聲部有獨立的主聲道。

## 7. 樂句的播放

- 樂句編輯器與審核頁：用同一套投影來畫和播，速度在本機固定 120（[`phrases.md`](phrases.md)）。
- 樂句側欄的預覽不載入音色庫：`soundFont: null`，也就是關掉播放器（`alphaTabEngine.ts:95-96`）。
