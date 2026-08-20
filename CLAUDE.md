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

## 鑰匙圈解鎖（2026-08-19 上線＋2026-08-20 視覺 v3 公版；別誤改）
- **一人一組密碼取代「貼 PAT」**：`public/keyring-unlock.js`（**正本在 `Claude Work/keyring/client/`，要改改那邊再複製過來**）抓公開的 `xd1104/keyring` repo 的 `keyring.json`（只有密文），使用者選自己＋輸密碼，瀏覽器用 WebCrypto（PBKDF2-SHA256 600000 → AES-GCM 256）解出金鑰。`appId: "recipe-book"`。
- **`recipe_gh_pat` 這個 key 不動**（跟舊版完全相容，GitHubStore 一行都沒改，手動貼過金鑰的裝置不用重貼）。`getToken()` 現在**先讀 sessionStorage**：解鎖時沒勾「記住這台裝置」就存那裡，關掉分頁即失效（借別人的電腦用）；`clearToken()` 兩邊都清。
- **身分藥丸放 `#kr-slot`**（列表工具列下方、`#readonly-note` 正上方）。理由：食譜本說明「你現在能不能改東西」的地方就是這一帶（唯讀提示 ＋ ⚙ 設定），解鎖動作放同一區才讀得懂；header 的 tabs 是導覽列，塞身分會把「匯入整理」擠掉。**本機版（LocalStore）不顯示**——電腦不用鑰匙。
- **守門照食譜本既有架構**：`applyModeUI()` 原本的 `body.readonly` ＋ `show('#btn-new'…)`「把入口藏起來」**沒有改**；另外加 `requireWrite(reason)` 當網子掛在三個寫入入口（新增／編輯／管理標籤），真的被點到就**升起解鎖畫面（v3 起是滿版）並帶理由條**，而不是丟一句 toast 叫他自己去找設定。**別把 requireWrite 當死碼清掉**（入口平常是藏的，但重繪時序／鍵盤都可能走到）。
- **唯讀提示文案**在有鑰匙圈時由 JS 覆寫成「點上面的『只看看模式・點我解鎖』…」；`index.html` 裡的原文案（「請在電腦上操作」）**留著當沒有模組時的 fallback**，別刪。
- **「⚙ 設定 → 貼金鑰」刻意保留**當救援入口（鑰匙圈壞掉時還能手動貼一把）。`settings-clear` 會一併 `Keyring.forget()`，否則下次載入 `init()` 又把金鑰寫回來；且 `forget()` 自己會觸發 `onChange → refreshAfterKeyChange`，**那條路徑不要再多呼叫一次**（兩份 loadRecipes 會打架）。
- **namespace ＝ `keyring.recipe-book.*`**（模組由 appId 推導）。刻意跟旅途手帳的 `keyring.travel-book.*` 分開：兩個 App 的裝置記憶不可互相污染。
- 裝置記憶存的是**派生金鑰**不是密碼：後台**換 PAT 時各裝置自動換過去、不用重解鎖**；**換密碼／刪人／收回權限則解不開 → 靜默清掉回到「只看看」**。抓不到 keyring.json（離線）時維持現狀。
- 首次進站約 0.9 秒主動彈一次解鎖畫面（旗標 `keyring.recipe-book.introSeen`），之後永遠不再自動彈。
- **解鎖畫面 v3「公版」（2026-08-20，Benson 拍板；只換視覺與版面，狀態機／加解密／對外 API 一行沒動）**——**這一段推翻了 v2「接變數吃 App 主色」的做法，不要改回去**：
  - **底部 sheet 改成滿版 `#kr-full`**（`.kr-sheet`／`.kr-backdrop`／`.kr-grab` 全移除），三段式 flex：`.kr-top`（App 名字＋✕）／`.kr-main > .kr-mid`（垂直置中、可捲）／`.kr-foot`（「先看看就好」常駐條）。**已解鎖點藥丸的身分頁與換人確認也是滿版。**
  - **解鎖畫面不吃食譜本的橘，跨 App 長得一模一樣**：暖墨咖啡 `rgba(26,21,16,.955)` ＋頂部暖光 ＋ backdrop blur，主鈕暖白 `#f6efe1` 深字。**病灶就是 v2 的半套主題化**——`.kr-why`／`.kr-err` 底色寫死粉色系、字卻吃 `--acc`，橘色 App 一接上去就是**粉底＋橘字**。v3 從根上拿掉這個狀態：**`#kr-full` 子樹內一個宿主變數都不准讀，連 `var(--acc, fallback)` 都不行**（fallback 一樣會造成半套）；模組自己的常數用 `--krs-*`。App 的身分靠左上角一行文字（預設 `document.title`＝「我的食譜本」）不靠顏色。
  - **`styles.css` 的 `:root` 那三個變數**：`--acc` 還有用（見下），`--acc-deep`／`--bad` 模組已經不讀了，留著不影響（食譜本自己的規則也沒用到）。
  - **唯一能碰主色的是身分藥丸 `.kr-chip`**（住在 `#kr-slot` 裡）：**底色永遠是模組固定的中性色 `#f6f2ea`，主色只准上前景**——只有 `.kr-cta`（「點我解鎖 ›」）吃 `var(--acc, #c1553f)`，所以食譜本這裡是橘字。`.kr-dot` 改滿彩度圓形 22px。
  - **頭像滿彩度漸層＋圓形**（形狀分語意：圓形＝人、圓角矩形＝菜色卡）。
  - **「先看看就好」是版面固定成員**（`.kr-foot` 全寬 62px 常駐條，每一屏都有）＋右上 ✕ ＋標題「**誰要編輯？**」。這三件事是「滿版沒有變成鎖屏」的關鍵，**改文案等於改掉這個設計**。
  - **safe-area 與鍵盤**：高度用 `var(--kr-vh,100dvh)`＋`visualViewport`（**不要用 `100vh`**）；`.kr-foot` 是 flex item **不是 `position:fixed`**（鍵盤彈出時自然停在鍵盤正上方），**不要「優化」成 fixed**。
  - **矮螢幕密度（QA 退件兩次修，機制別再換回去）**：鍵盤彈出後可視高度只剩 340~440px（iPhone SE 約 407px），原尺寸會讓「解鎖」鈕掉到摺線下面。
    - **⚠️ 不可以用 `@media(max-height:…)`**：媒體查詢吃的是 **CSS 視窗高度**，而 **iOS 鍵盤只縮 `visualViewport`、CSS 視窗高度一動也不動** ⇒ 媒體查詢永遠不觸發。**Android 會過、iPhone 不會**（實證：`--kr-vh`=407 時解鎖鈕可見高度 0px）。這也正是模組本來就有 `--kr-vh`／`fitVH()` 的原因。
    - **正解**：`applyDensity()` 依**實際量到的滿版高度**在 `#kr-full` 上加／移除 `.kr-short`(≤640)／`.kr-tiny`(≤500)／`.kr-micro`(≤460)，緊縮規則全部寫成 `#kr-full.kr-short …`；再掛一個 **ResizeObserver** 在 layer 上，任何原因（鍵盤、轉向、測試直接改 `--kr-vh`）造成的高度變化都會重算。
    - **門檻是用最壞情境定的**（理由條 ＋ 已打錯 2 次＝錯誤條兩行），不是用單純情境——單純情境會給出假的安全感。`.kr-micro` 刻意讓掉三樣次要的東西（理由條、錯誤條第二行、出口第二行）換「密碼欄＋解鎖鈕＋出口」完整可見；**觸控目標 ≥44px 與密碼欄 16px 不准讓**。
    - **已知缺口（QA 建議級，刻意先不修）**：`.kr-micro` 把理由條整條 `display:none`。正常路徑不受影響（他點寫入鍵的當下畫面還是全高、看得到理由，鍵盤才彈出）；但**一開機就矮**（手機橫置／桌機小視窗）時，他從頭到尾看不到「為什麼被擋」。要收的話把理由縮成一行併進副標即可。
    - 實測（最壞情境、不捲動）：`--kr-vh` = 340/380/407/440/500 兩個 App 全過，破線點在 **~318px**（比 QA 要求的最低 340 還低 22px）。
  - **量測方法（前兩輪雙方都在這裡失準過）**：① 量之前 `scrollTop` 一律歸 0；② 不要只看 `getBoundingClientRect`（它不管捲動容器的裁切）；③ 至少兩種方法交叉驗：clip-aware 交集（走 overflow 祖先，但**走到 `#kr-full` 就要停**——它是 `position:fixed`，body/html 的 overflow 裁不到它，多走一層會誤判成被裁掉）／`elementFromPoint` 打按鈕（**用邊中點不要用四角**，圓角 15px 會讓角落落在形狀外）／截圖掃暖白 `rgb(246,239,225)` 像素（**掃描欄要避開置中的「解鎖」字樣**，否則連續段會被文字切斷）。
  - **同名的人靠前端分辨**（`hintOf()`）：後台填了 `hint` 就顯示，沒填但名字重複就顯示 `id`。**刻意不改後台、不改資料格式。**
- **模組 CSS 的權重鐵律**：**滿版層內一律 `#kr-full .kr-x{}`（1,1,0，綁模組自己的 id）**；**滿版層外（只有藥丸）用同一個 class 寫兩次 `.kr-chip.kr-chip{}`（0,2,0）**才壓得過宿主常見的 `.foo button`（0,1,1）。**不可以**改寫成 `.kr-slot .kr-chip` 這種依賴宿主結構的寫法（把宿主寫死進模組，下一個複製這個檔案的 App 會再壞一次）。`styles.css` 裡只准有 `.kr-slot` 的排版，不准碰 `kr-` 開頭的樣式。
  - 同一個坑的變形：**`#kr-full .kr-id span` 會連頭像那顆 `<span class="kr-av">` 一起選到**（1,1,1 壓過 1,1,0），66px 圓頭像會變 13.5px 灰字。副標因此寫成 `.kr-id div span`。
- **第二條滲漏路徑：宿主的「繼承屬性」（QA 退件修）**——跟「權重被壓」是不同的病，**權重擋不住它**（模組根本沒宣告那個屬性）。實測抓到：旅途手帳有 `-webkit-tap-highlight-color:transparent`、食譜本沒有 ⇒ **同一顆頭像磚在 iPhone 上一個 App 點下去會閃灰、另一個不會**；還有 `text-size-adjust`、隱藏 checkbox 的 `font-size`。修法：在 `#kr-full` 與 `.kr-chip` **把會繼承的屬性一次寫死**，`#kr-full input` 補 `font-size:16px`。
  - **驗法**：`getComputedStyle` 全部屬性（~340 項）逐項比對兩個 App，不是挑幾項看。目前差異 = **0**（只剩 `.kr-chip .kr-cta` 的 `color` 與 16 個 `currentColor` 衍生屬性＝唯一允許吃 `--acc` 的鉤子）。宿主 `:root` 的變數會被繼承進 computed style，但**模組不讀它們**，不算滲漏。
- **改這個模組的驗收線**：同一份模組在食譜本與旅途手帳裡，解鎖畫面的 **computed style 必須逐項相同**（「公版」的機器定義）；`#kr-full` 子樹 grep 不到 `var(--acc`／`--ink`／`--line`…；`.kr-go` 底色必須 `rgb(246,239,225)`、`.kr-chip` 必須 `rgb(246,242,234)`；`#kr-pw` `font-size` 必須 `16px`；觸控目標 ≥44px。
- 改前端記得 `sw.js` **三個 cache 版本一起 +1**（目前 **v18**），`SHELL` 要含 `keyring-unlock.js`。**食譜本刻意沒有 `APP_VER` 那套版本提示機制**（那是旅途手帳的），別順手加。
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
