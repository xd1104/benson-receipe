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
- 手貼金鑰現在只是**救援入口**：日常改用下一節的「鑰匙圈解鎖」（選自己＋輸密碼）。

## 鑰匙圈解鎖（2026-08-19 上線；別誤改）
- **一人一組密碼取代「貼 PAT」**：`public/keyring-unlock.js`（**正本在 `Claude Work/keyring/client/`，要改改那邊再複製過來**）抓公開的 `xd1104/keyring` repo 的 `keyring.json`（只有密文），使用者選自己＋輸密碼，瀏覽器用 WebCrypto（PBKDF2-SHA256 600000 → AES-GCM 256）解出金鑰。`appId: "recipe-book"`。
- **`recipe_gh_pat` 這個 key 不動**（跟舊版完全相容，GitHubStore 一行都沒改，手動貼過金鑰的裝置不用重貼）。`getToken()` 現在**先讀 sessionStorage**：解鎖時沒勾「記住這台裝置」就存那裡，關掉分頁即失效（借別人的電腦用）；`clearToken()` 兩邊都清。
- **身分藥丸放 `#kr-slot`**（列表工具列下方、`#readonly-note` 正上方）。理由：食譜本說明「你現在能不能改東西」的地方就是這一帶（唯讀提示 ＋ ⚙ 設定），解鎖動作放同一區才讀得懂；header 的 tabs 是導覽列，塞身分會把「匯入整理」擠掉。**本機版（LocalStore）不顯示**——電腦不用鑰匙。
- **守門照食譜本既有架構**：`applyModeUI()` 原本的 `body.readonly` ＋ `show('#btn-new'…)`「把入口藏起來」**沒有改**；另外加 `requireWrite(reason)` 當網子掛在三個寫入入口（新增／編輯／管理標籤），真的被點到就**升起解鎖 sheet 並帶理由條**，而不是丟一句 toast 叫他自己去找設定。**別把 requireWrite 當死碼清掉**（入口平常是藏的，但重繪時序／鍵盤都可能走到）。
- **唯讀提示文案**在有鑰匙圈時由 JS 覆寫成「點上面的『只看看模式・點我解鎖』…」；`index.html` 裡的原文案（「請在電腦上操作」）**留著當沒有模組時的 fallback**，別刪。
- **「⚙ 設定 → 貼金鑰」刻意保留**當救援入口（鑰匙圈壞掉時還能手動貼一把）。`settings-clear` 會一併 `Keyring.forget()`，否則下次載入 `init()` 又把金鑰寫回來；且 `forget()` 自己會觸發 `onChange → refreshAfterKeyChange`，**那條路徑不要再多呼叫一次**（兩份 loadRecipes 會打架）。
- **namespace ＝ `keyring.recipe-book.*`**（模組由 appId 推導）。刻意跟旅途手帳的 `keyring.travel-book.*` 分開：兩個 App 的裝置記憶不可互相污染。
- 裝置記憶存的是**派生金鑰**不是密碼：後台**換 PAT 時各裝置自動換過去、不用重解鎖**；**換密碼／刪人／收回權限則解不開 → 靜默清掉回到「只看看」**。抓不到 keyring.json（離線）時維持現狀。
- 首次進站約 0.9 秒主動彈一次解鎖 sheet（旗標 `keyring.recipe-book.introSeen`），之後永遠不再自動彈。
- **色票用「接變數」不是「改模組」**：模組的 `kr-` 樣式寫成 `var(--acc, <珊瑚紅預設>)`，`styles.css` 的 `:root` 補了 `--acc/--acc-deep/--bad` 接到食譜本的橘（App 自己的規則沒用到這三個變數）。**模組本身一個字都沒改**——那組視覺是 lab-ux 定案的，要改得走設計。
- **模組 CSS 的權重鐵律**：每條規則都用同一個 class 寫兩次（`.kr-chip.kr-chip` ＝ 0,2,0）才壓得過宿主常見的 `.foo button`（0,1,1）。**不可以**改寫成 `.kr-slot .kr-chip` 這種依賴宿主結構的寫法（把宿主寫死進模組，下一個複製這個檔案的 App 會再壞一次）。`styles.css` 裡只准有 `.kr-slot` 的排版，不准碰 `kr-` 開頭的樣式。
- 改前端記得 `sw.js` **三個 cache 版本一起 +1**（目前 **v17**），`SHELL` 要含 `keyring-unlock.js`。**食譜本刻意沒有 `APP_VER` 那套版本提示機制**（那是旅途手帳的），別順手加。
- 本機測試：`localStorage["keyring.recipe-book.src"]` 可指到別份 keyring.json（例如本機後台 `http://localhost:4620/keyring.json`）；`?store=github` 可在 localhost 強制走 GitHubStore 來測整條解鎖流程。

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
