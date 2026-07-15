# recipe-book — 專案備忘（給接手的 AI／開發者）

個人食譜本 PWA。Benson（＋女友）自己用：記食譜＋照片、批次匯入 .txt 由 AI 整理，手機/電腦到哪都能看＋加。

## 架構（三層 — 別打破）
- **電腦本機 Node App＝真本＋AI**：`server.js`（零執行期依賴，port 3517），存本機檔為權威副本，並跑「AI 整理」。
- **GitHub 公開 repo `xd1104/benson-receipe`（main）＝跨裝置同步中樞＋雲端備份**。
- **GitHub Pages `xd1104.github.io/benson-receipe/`＝手機/其他裝置的 PWA**（前端由 `build.js` 從 `public/` 鏡射到 `docs/`；Pages 服務 `main /docs`）。

## 前端 DataStore（依 `location.hostname` 自動切）
- **localhost → LocalStore**：打本機 `/api`，全功能（新增/編輯/匯入/AI 整理/管理標籤）。
- **非 localhost（Pages）→ GitHubStore**：直接打 GitHub Contents/raw。**有金鑰**才解鎖編輯、內容走認證 Contents API（即時）；**無金鑰**唯讀、走 raw＋`?t=<sha>` cache-buster。AI 整理與批次匯入**永遠只在 localhost**（查 `location.hostname`，跟金鑰無關）。

## 同步（別誤改的決策）
- 本機 LocalStore 寫入成功後自動 `git add/commit` → **`git pull --no-rebase -X ours`** → `push`；啟動時也 pull。
- 同一食譜檔衝突：**固定電腦版本勝（`-X ours`）**——刻意選「電腦是真本」。若要改「手機（較晚）勝」改成 `-X theirs`（需 Benson 拍板）。
- 手機寫入：GitHub Contents API `PUT/DELETE` 帶 `sha`＋base64＋`Authorization: token <PAT>`；409(sha 過期)自動重取重試一次。**樂觀更新**：寫入成功後直接用送出的資料更新畫面，不等重抓（避免 CDN 延遲讓人以為沒存）。

## 金鑰（安全）
- 手機用 **fine-grained PAT、只授權 `benson-receipe` 這一個 repo 的 Contents 讀寫**，存 localStorage（key `recipe_gh_pat`）。**Benson 跟女友共用同一把**。**任何真實金鑰都不可寫進程式或 commit。**

## 資料格式
- 每道食譜一個 `data/recipes/<id>-<slug>.md`：frontmatter（title/tags/createdAt/updatedAt/image）＋ `## 食材`(- 條列) / `## 步驟`(1. 編號，某步可接縮排 `![step](images/xxx.md)`) / `## 備註`。圖片 `data/images/`，標籤 `data/tags.json`。
- **`.gitattributes` 強制 `data/*.md` 為 LF**：Windows autocrlf 會把 md 轉 CRLF，而 parser 只認 `\n` → frontmatter 解析壞、標題變空白。前後端 parser 開頭都先 `replace(/\r\n/g,'\n')`。舊食譜相容不可破壞。

## 已知雷 / 提醒
- 測「最新」用**有金鑰的裝置**：無金鑰走 GitHub 匿名 API 會嚴重快取延遲（可能回好幾版舊）。
- 換 icon / 更新後，iOS 已安裝的 PWA 要**移除主畫面重加**才會換 icon；SW 用 skipWaiting＋清舊快取＋clients.claim。
- PWA 在 Pages 子路徑下：資源、manifest `start_url`/`scope`、SW scope 一律相對路徑（別用開頭 `/`）。
- iOS 表單自動放大：input/textarea/select `font-size ≥ 16px`（別用 maximum-scale=1）。
- repo 名 **`benson-receipe`**（receipe 拼字，照 Benson 給的字串用）。
- 產 icon 用的 `sharp` 只在 build 期、裝在 scratchpad、**不進 repo**；server.js 維持零執行期依賴。

## 啟動
- 雙擊 `start.bat`，或從 tool-manager 面板「作品」分類啟動（node server.js，port 3517）。
