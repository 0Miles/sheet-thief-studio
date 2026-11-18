# 部署

正式環境用 Docker Compose 跑四個服務：server（API、`/collab` 共編，也提供網頁）、Postgres、Redis、辨識服務。部署有兩種模式，擇一使用：

| | 獨立部署 | plugin 模式 |
|---|---|---|
| 網址 | 自己的網域，例如 `https://studio.example.com/` | bot 的網域底下：`https://bot.example.com/plugin/sheet-thief-studio/` |
| 站在 server 前面的 | 這台主機上的 nginx（TLS 也在這裡） | karyl-chan bot 的 plugin 代理 |
| 登入 | 帳號密碼，session 放在 cookie | 在 Discord 打 `/studio` 拿到的連結，session 用 Bearer token（[`spec/karyl-login.md`](spec/karyl-login.md)） |
| Compose | `compose.yaml` + `compose.standalone.yaml` | `compose.yaml` + `compose.plugin.yaml` |

兩種模式不能同時開：會改動東西的請求要帶和 `PUBLIC_ORIGIN` 相同的 `Origin`，而 `PUBLIC_ORIGIN` 只有一個。

這份文件只說怎麼做；實際部署是人工步驟（#74）。

## 1. 檔案

| 檔案 | 內容 |
|---|---|
| `apps/server/Dockerfile` | server 的 image：建置網頁與 server，由 server 提供網頁（`WEB_ROOT`）。從 repo 根目錄建置 |
| `.dockerignore` | 建置 server image 時不送進去的檔案（`node_modules`、`.env` 等） |
| `deploy/compose.yaml` | 四個服務、volume、內部網路 `backend` |
| `deploy/compose.standalone.yaml` | 獨立部署：server 開在主機的 `127.0.0.1:8031`，加上網路 `edge` |
| `deploy/compose.plugin.yaml` | plugin 模式：server 加入 bot 的 `karyl-chan-net` 與 plugin 的設定 |
| `deploy/.env.example` | 所有設定的範例，沒有真的祕密；複製成 `deploy/.env` |
| `deploy/nginx/studio.conf` | 獨立部署的 nginx |
| `deploy/nginx/karyl-chan-plugin.conf` | plugin 模式下，bot 前面若有 nginx，要加進去的 `location` |

以下的指令都在 `deploy/` 目錄裡執行。`.env` 的 `COMPOSE_FILE` 決定模式，所以 `docker compose` 不必再帶 `-f`。

## 2. 需要的東西

- Linux 主機，Docker Engine 與 Docker Compose v2。
- 獨立部署：nginx 1.25.1 以上（範例用 `http2 on`）與網域的 TLS 憑證。
- plugin 模式：karyl-chan bot 已經用它自己的 Compose 跑起來，`karyl-chan-net` 網路已存在（`docker network ls`）；能進 bot 的 `/admin/plugins`。

## 3. 設定

```bash
cp .env.example .env
chmod 600 .env
```

然後編輯 `.env`。`.env` 不進 git（`.gitignore`）。

| 變數 | 模式 | 說明 |
|---|---|---|
| `COMPOSE_FILE` | 兩者 | 留下 `.env.example` 裡兩行之一：決定模式 |
| `POSTGRES_PASSWORD` | 兩者 | 必填。Postgres 的密碼，會直接放進 `DATABASE_URL`，所以只用英數，例如 `openssl rand -hex 32` |
| `PUBLIC_ORIGIN` | 兩者 | 必填，結尾不加 `/`。獨立部署是自己的網域（`https://studio.example.com`）；plugin 模式是 bot 的公開 origin（`https://bot.example.com`） |
| `DATABASE_URL`、`REDIS_URL`、`RECOGNIZER_URL` | 兩者 | 選填，預設指向 `compose.yaml` 裡的服務 |
| `STUDIO_IMAGE_TAG` | 兩者 | 選填，Compose 建置的 image 的 tag，預設 `latest`。每次升級用新的 tag，舊的 image 就留著可以退回 |
| `HSTS` | 兩者 | 選填。`1` 時回應帶 `Strict-Transport-Security`；獨立部署預設 `1`，plugin 模式預設 `0`（由 bot 的網域自己決定） |
| `STUDIO_PORT` | 獨立 | 選填，server 在主機 loopback 上的 port，預設 `8031`；要和 nginx 的 `upstream` 一致 |
| `EDGE_SUBNET`、`EDGE_GATEWAY` | 獨立 | 選填，網路 `edge` 的子網路與閘道，預設 `172.31.73.0/24`、`172.31.73.1`。這台主機已經有網路用了這段時，兩個一起改 |
| `TRUSTED_PROXIES` | 兩者 | server 只信任這個位址送來的 `X-Forwarded-For`（[`spec/security.md`](spec/security.md) 第 4 節）。獨立部署預設是 `EDGE_GATEWAY`（見第 8 節）；plugin 模式必填，見第 9.2 節 |
| `KARYL_PLUGIN_SETUP_SECRET` | plugin | 必填。bot 的 `/admin/plugins` 發的 setup secret；設了才會進 plugin 模式 |
| `BOT_URL` | plugin | 選填，bot 在 `karyl-chan-net` 上的位址，預設 `http://karyl-chan:3000`（bot 的容器名稱不同時才改） |
| `PLUGIN_URL` | plugin | 選填，bot 連到 studio 的位址，預設 `http://karyl-plugin-sheet-thief-studio:8031`（`compose.plugin.yaml` 給 server 的別名） |

image 裡已經設好、不必改的：`NODE_ENV=production`、`HOST=0.0.0.0`、`PORT=8031`、`WEB_ROOT`。`INSECURE_COOKIES` 在正式環境無效，不要設。

## 4. 建置

```bash
docker compose build
```

建置 server（先 build 網頁，再裝 server 需要的套件）與辨識服務兩個 image。網頁的 build 不含測試與量測用的掛鉤；含的話建置會失敗（[`spec/testing.md`](spec/testing.md) 第 2 節）。

## 5. 遷移

```bash
docker compose run --rm server studio-cli migrate
```

建立或更新資料表。會先啟動 Postgres、Redis 與辨識服務並等它們就緒。第一次部署與每次升級都要跑；已經跑過的遷移會跳過，輸出「資料庫已是最新。」。

## 6. 建立第一個 admin

```bash
docker compose run --rm server studio-cli create-admin <帳號名稱> <顯示名稱>
```

密碼不放在指令列：在終端機裡會提示輸入兩次、不顯示（10–256 字元）。從檔案讀時加 `-T`，讀標準輸入的第一行：

```bash
docker compose run --rm -T server studio-cli create-admin miles Miles < password.txt
```

只需要做一次；之後的帳號由 admin 在 `/admin` 建立。plugin 模式還要把這個 admin 綁上 Discord id 才登入得了，見第 9.5 節。

## 7. 啟動

```bash
docker compose up -d
docker compose ps          # 四個服務都是 healthy
docker compose logs -f server
```

所有服務都設了 `restart: unless-stopped`，主機重開後會自己起來。Postgres、Redis 與辨識服務只在內部網路 `backend` 上，沒有對外的 port，也連不到外面。

## 8. 獨立部署：nginx

1. 把 `deploy/nginx/studio.conf` 放進 nginx 的 http context（例如 `/etc/nginx/conf.d/`），換掉 `studio.example.com` 與憑證路徑。改過 `STUDIO_PORT` 的話，`upstream` 的 port 也一起改。
2. `sudo nginx -t && sudo systemctl reload nginx`。
3. 用第 6 節的 admin 從 `https://studio.example.com/` 登入。

範例做的事：

- TLS 在 nginx；http 轉到 https。server 預設送 `Strict-Transport-Security`（`HSTS=1`）。
- `/collab` 轉發 WebSocket 的 Upgrade，連線最長保持 1 小時沒有資料。
- `/s/`、`/api/s/`（唯讀連結的 token 在路徑裡）與 `/auth/karyl`（token 在 query 裡）不記 `access_log`（[`spec/security.md`](spec/security.md) 第 9 節）。
- `client_max_body_size 42008576`：server 收得最大的 body，一次辨識的圖片（`apps/server/src/limits.ts` 的 `RECOGNITION_BODY_LIMIT`，40 MB 加 64 KB）。其他路由的上限比較小，由 server 自己回 413。這個值改了，nginx 也要跟著改。
- `X-Forwarded-For` 是用 `$remote_addr` 蓋掉的，不是附加上去的：用戶端塞進來的位址不會被當成它的 IP。

**`TRUSTED_PROXIES`**：nginx 經由 Docker 發布的 port 連到 server，server 看到的來源是網路 `edge` 的閘道（`EDGE_GATEWAY`），所以預設就信任這個位址。nginx 跑在別的地方（例如另一個容器）時，把 `TRUSTED_PROXIES` 改成 nginx 連進來的位址；設錯的話，所有人會被當成同一個 IP，一起受速率限制。

## 9. plugin 模式

### 9.1 在 bot 建立 plugin

1. bot 的 `/admin/plugins` →「New Plugin」，key 填 **`sheet-thief-studio`**（要和 studio 送出的 manifest 一致）。
2. 畫面只會顯示一次 setup secret：貼進 `.env` 的 `KARYL_PLUGIN_SETUP_SECRET`。

原票寫的「在 bot 的 `/admin/services` 註冊 service」是舊的 service-login 做法；#72 改成 plugin 之後不用了，studio 不在 bot 註冊 service。

### 9.2 `.env`

- `COMPOSE_FILE=compose.yaml:compose.plugin.yaml`。
- `PUBLIC_ORIGIN`：bot 的公開 origin，例如 `https://bot.example.com`。頁面從 bot 的網域送出，瀏覽器的 `Origin` 是它。
- `TRUSTED_PROXIES`：bot 在 `karyl-chan-net` 上的位址。bot 容器的 IP 每次重建可能不同，所以填整個網路的子網路：

  ```bash
  docker network inspect karyl-chan-net --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
  ```

  這樣同一個網路上的其他 plugin 也被信任，可以偽造 `X-Forwarded-For`；影響只有速率限制用的 IP。
- `BOT_URL`、`PLUGIN_URL` 通常用預設值。

### 9.3 bot 那一側的設定（在 bot 的部署裡改，不在這個 repo）

- **`WEB_BODY_LIMIT_BYTES`**：bot 的預設是 30 MiB，比 studio 一次辨識的上限（40 MB 加 64 KB，`42008576` bytes）小，超過 30 MiB 的辨識會在 bot 就被擋下（413）。要讓辨識用到上限，把它設成至少 `42008576`。
- **`WEB_BASE_URL`**：bot 用它組出 plugin 的 `publicBaseUrl`（`<WEB_BASE_URL>/plugin/sheet-thief-studio`），`/studio` 的連結用這個網址。bot 沒設時，studio 用 `PUBLIC_ORIGIN` 加上 `/plugin/sheet-thief-studio`。
- **bot 前面的 nginx**（有的話）：把 `deploy/nginx/karyl-chan-plugin.conf` 標示的 `location` 加進 bot 的 `server` 區塊。它們讓 `/plugin/sheet-thief-studio/collab` 轉發 WebSocket 的 Upgrade、放寬 body 上限，並且不記登入連結與唯讀連結的 `access_log`。bot 的代理自己記不記這些網址，studio 管不到；所以登入連結只能用一次、2 分鐘內有效（[`spec/karyl-login.md`](spec/karyl-login.md) 第 2 節）。

### 9.4 建置、遷移、啟動

照第 4–7 節：`docker compose build`、`docker compose run --rm server studio-cli migrate`、`create-admin`、`docker compose up -d`。

server 先開始服務，再向 bot 註冊；bot 還沒準備好時 SDK 會在背景重試，不影響 server 啟動。

### 9.5 確認與啟用

1. bot 的 `/admin/plugins`：`sheet-thief-studio` 幾秒內離開「awaiting first registration」，版本變成 manifest 的版本。
2. **打開它的開關**：剛註冊的 plugin 預設是停用的。
3. bot 設了 `PLUGIN_AUTO_APPROVE=false` 時，在 plugin 的卡片或 Security 分頁核准 `auth.session` 這個 scope；沒核准的話 `/studio` 發不出連結。
4. 把第一個 admin 綁上自己的 Discord id。plugin 模式下密碼登入的 cookie 到不了 server（bot 的代理會刪掉 cookie），而在 `/admin` 綁定需要先以 admin 登入，所以第一筆直接寫進資料庫（Discord id 是 17 到 20 位數字）：

   ```bash
   docker compose exec postgres psql -U studio -d studio -c \
     "INSERT INTO identities (account_id, provider, subject) SELECT id, 'karyl-chan', '<Discord id>' FROM accounts WHERE username = '<帳號名稱>';"
   ```

   輸出 `INSERT 0 1` 才是成功；`INSERT 0 0` 表示帳號名稱打錯。之後其他人的綁定由 admin 在 `/admin` 做（[`spec/karyl-login.md`](spec/karyl-login.md) 第 4 節；畫面屬於 #72 的網頁那一塊，在它合併之前可以用同一個指令）。
5. 在 bot 所在的 Discord 伺服器打 `/studio`：只有自己看得到的連結，點下去就登入。未綁定的 Discord id 會在 `/login` 看到自己的 id，交給 admin 綁定。

## 10. 備份 Postgres

所有要保存的資料（帳號、團譜、版本、樂句、辨識）都在 Postgres。

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U studio -d studio -Fc > "backups/studio-$(date +%Y%m%d-%H%M%S).dump"
```

- 用 cron 之類的排程每天做一次，並把 `backups/` 複製到這台主機以外的地方。dump 裡有密碼雜湊與所有團譜，照祕密的等級保管。
- Redis 不必備份：裡面是 session、速率限制、共編 ticket 與用過的登入連結。遺失的結果是所有人要重新登入。
- 辨識服務沒有狀態。

還原（會蓋掉現在的資料）：

```bash
docker compose stop server
docker compose exec -T postgres pg_restore -U studio -d studio --clean --if-exists < backups/<檔名>.dump
docker compose start server
```

## 11. 升級

1. 先備份（第 10 節）。
2. 取得新版：`git fetch` 之後切到要部署的 commit 或 tag。
3. 在 `.env` 把 `STUDIO_IMAGE_TAG` 改成新版本的名稱，然後 `docker compose build`。舊 tag 的 image 留著，要退回時改回舊 tag 即可。
4. 停掉 server，跑遷移，再全部啟動：

   ```bash
   docker compose stop server
   docker compose run --rm server studio-cli migrate
   docker compose up -d
   ```

   停掉 server 再遷移，是為了不讓舊版的 server 跑在新的資料表上。停機時間是遷移加上啟動的時間。
5. `docker compose ps` 都是 healthy，`docker compose logs server` 沒有錯誤。plugin 模式再到 bot 的 `/admin/plugins` 確認它重新註冊、仍是啟用。

退回：遷移沒有自動的反向步驟。新版跑過遷移之後要退回，用升級前的備份還原（第 10 節），再用舊的 `STUDIO_IMAGE_TAG` 啟動。

## 12. CI 檢查的部分

CI 的 `deploy` job（`.github/workflows/ci.yml`）：兩種模式的 `docker compose config`（用 `.env.example`）、建置 server 的 image 並確認裡面的程式載入得了、兩份 nginx 範例在 nginx 官方 image 裡通過 `nginx -t`。辨識服務的 image 由 `recognizer` job 建置。
