# 我的食譜本 (Recipe Book)

個人食譜本 — 本機 PWA。可記錄食譜、上傳圖片、批次匯入雜亂 .txt 並用本機 `claude` CLI「AI 整理」成結構化食譜。資料全部存成本機檔案，之後可用 git 同步到手機。

## 怎麼啟動

**雙擊 `start.bat`** 即可。它會：
1. 在一個新視窗啟動 Node 伺服器（`node server.js`，預設 http://localhost:3517）。
2. 等約 2 秒後自動開瀏覽器。

要停止伺服器：關掉那個 server 視窗即可。

> 也可手動啟動：在本資料夾開 PowerShell，執行 `node server.js`，再瀏覽 http://localhost:3517

需求：已安裝 Node.js（本機驗證版本 v22）。無任何 npm 依賴，不需 `npm install`。

## 資料存哪

- `data/recipes/` — 每道食譜一個 `.md` 檔（frontmatter + markdown，人類可讀、git 友善）。
- `data/images/` — 上傳的圖片。
- `data/imports/` — 批次匯入、等待 AI 整理的原始 .txt。

食譜 `.md` 格式範例：

```markdown
---
title: "番茄炒蛋"
tags: ["快炒", "家常"]
createdAt: "2026-07-15T02:00:00.000Z"
updatedAt: "2026-07-15T02:00:00.000Z"
image: "1752....-ab12.jpg"
---

# 番茄炒蛋

## 食材

- 番茄 2 顆
- 蛋 3 顆

## 步驟

1. 蛋打散
2. 熱鍋炒蛋盛起
3. 炒番茄後回鍋拌炒

## 備註

小訣竅…
```

要同步到手機：直接把整個 `data/` 資料夾（或整個 repo）用 git push / pull 即可，`.md` 與圖片都是純檔案。

## AI 整理 — 登入前置條件（重要）

「AI 整理」用本機的 `claude` CLI（零額外 API 費用，走你的訂閱額度）。後端會自動解析出真正的 `claude.exe` 絕對路徑並以 `shell:false` 呼叫，繞開 Windows 的 `cmd.exe ENOENT` 問題。

**前置條件**：獨立啟動的全域 CLI 讀不到 Claude Desktop 內嵌版的登入狀態。若 AI 整理回報「未登入」，請：

1. 開一般 PowerShell。
2. 執行一次 `claude`（跟著完成登入流程）。
3. 回到食譜本再按「AI 整理」即可。

若找不到 CLI，可設定環境變數 `CLAUDE_EXE` 指向 `claude.exe` 絕對路徑後再啟動。

## 功能

- 新增／編輯／刪除食譜（標題、標籤、食材、步驟、備註）。
- 每道食譜上傳封面圖，**每個步驟也可各自放一張過程圖**。
- 標籤用點選（chips），可管理（新增／改名／刪除，會同步更新食譜）。
- 主頁分類篩選（沿用標籤 + 全部）。
- 搜尋（標題／標籤／食材）。
- 批次匯入多個 .txt，逐一「AI 整理」→ 檢視 → 存成食譜。
- **閱讀模式**：點食譜卡進入乾淨大字版面（做菜時用），步驟圖放大顯示；按「編輯」切回表單。
- **大圖自動壓縮**：上傳前在前端縮到最長邊約 1600px、轉 JPEG（封面與步驟圖皆是），省空間也更快。
- **一鍵備份**：「匯入整理」分頁底部可「匯出全部備份」（含所有食譜＋圖片的單一 JSON），也可「還原備份」。
- **離線可看**：service worker 對食譜資料採 network-first、圖片 cache-first；手機離線或那台電腦沒開時，仍看得到之前載入過的食譜與圖（寫入類操作會提示離線）。
- **原子寫入**：所有存檔先寫暫存檔再 rename 覆蓋，避免中途當機產生半截壞檔。
- PWA：手機瀏覽器可「加到主畫面」安裝，響應式版面。

## 技術

- 前端：原生 HTML/CSS/JS，單頁 PWA（manifest + service worker + icon）。
- 後端：Node.js 內建 `http`，**零外部依賴**。圖片以 base64 JSON 上傳、後端解碼存檔。
- Port：預設 3517，可用環境變數 `PORT` 覆蓋。
