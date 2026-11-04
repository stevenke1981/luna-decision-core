# luna-decision-core 使用說明

這份說明以 Windows 上的 PowerShell 7（`pwsh`）為例，適用於 `D:\luna-decision-core`。工具需要 Node.js 22.15 以上。

工具提供六類決策：選模型與 reasoning effort、選技能、檢索程式碼、讀取記憶、寫入記憶，以及壓縮上下文。Claude、Codex 或你的 agent 程式取得結果後，再執行換模型、讀取技能與套用上下文等動作。單獨啟動工具不會自動接管 agent。

## 1. 安裝與第一次執行

本機已經有專案，直接執行：

```powershell
Set-Location D:\luna-decision-core
node --version
node .\bin\luna-core.js --version
node .\bin\luna-core.js route --mode heuristic --task "重新命名一個區域變數"
```

最後一行只使用本機規則，不需要金鑰，也不呼叫 Luna。成功時會輸出 JSON，`source` 為 `rules`。

想直接使用 `luna-core` 指令，可在套件資料夾執行一次：

```powershell
npm link
luna-core --help
```

找不到 `luna-core` 時，可繼續使用 `node D:\luna-decision-core\bin\luna-core.js` 取代。專案沒有執行期相依套件，不需要先執行 `npm install`。

其他電腦可先下載：

```powershell
git clone https://github.com/stevenke1981/luna-decision-core.git
Set-Location luna-decision-core
npm link
```

## 2. 設定 Luna 金鑰與執行模式

在套件根目錄 `D:\luna-decision-core\.env.local` 填入自己的 OpenAI API 金鑰：

```dotenv
OPENAI_API_KEY=你的金鑰
LUNA_CORE_MODE=auto
```

也可以從 `.env.example` 複製一份，再取消需要的設定行前面的 `#`。若 `.env.local` 已存在，直接編輯即可。

```powershell
notepad D:\luna-decision-core\.env.local
```

金鑰僅供 Luna 決策使用；執行選中的 Claude 或 GPT 主模型，仍由外層程式處理其登入與費用。不要把金鑰放進 JSON 設定檔或 MCP 參數。

設定後檢查：

```powershell
luna-core config
luna-core probe
```

`config` 的 `apiKey` 顯示 `set` 或 `unset`。`probe` 會實際呼叫一次 Luna，產生 API 費用；成功時可查看 `source`、`calls`、`tokens`、`cost`。沒有金鑰或呼叫失敗時，以 exit code 1 結束。

| 模式 | 用法 | 行為 |
|---|---|---|
| `heuristic` | `--mode heuristic` | 全程使用本機規則，不呼叫 Luna |
| `auto` | 預設；也可用 `--mode auto` | 問 Luna；失敗或信心不足時改用規則，並回報原因 |
| `luna` | `--mode luna` | 嚴格模式；Luna 失敗時讓這次決策失敗 |

選項放在子指令後面，例如 `luna-core route --mode heuristic --task "..."`。`probe` 固定使用嚴格模式。

Shell 中已設定的非空環境變數優先於 env 檔；`LUNA_API_KEY` 優先於 `OPENAI_API_KEY`。env 檔依序讀取套件資料夾的 `.env.local`、`.env`，再讀取工具家目錄的同名檔案。

## 3. 設定技能目錄與可檢索的專案

建立 `D:\luna-decision-core\luna-core.config.user.json`。以下示例請把技能路徑、`D:/your-project` 換成實際位置：

```json
{
  "skills": {
    "dirs": ["C:/Users/eda/.agents/skills"],
    "maxSkills": 3
  },
  "retrieve": {
    "allowedRoots": ["D:/your-project"],
    "budgetTokens": 4000
  }
}
```

讓目前 PowerShell 視窗中的指令使用這份設定：

```powershell
$env:LUNA_CORE_CONFIG = "D:\luna-decision-core\luna-core.config.user.json"
luna-core config
```

單次指令也可以指定 `--config`。MCP 的設定方法見第 5 節。

`skills.dirs` 會掃描 `<目錄>/<技能名稱>/SKILL.md`。`retrieve.allowedRoots` 決定允許檢索哪些資料夾；空清單時只能檢索載入設定時的工作資料夾與其子目錄。連結解析後的實際路徑也必須在允許範圍內。

`skills.dirs`、`retrieve.allowedRoots` 等敏感設定必須放在明確指定的設定檔，或工具家目錄的 `config.json`。直接放進工作資料夾自動發現的 `luna-core.config.json` 會報錯。

若要調整路由候選模型，可從 [設定範例](../luna-core.config.example.json) 複製 `route.models` 到自己的設定檔。`tier` 越高代表排序越後面；`contextWindow`、`capabilities`、`efforts` 與 `strengths` 請依實際模型能力設定。這些值是路由依據，工具不會代你確認帳號是否有該模型的使用權。

## 4. 六類指令

### 選模型與 effort

```powershell
luna-core route --task "修正多執行緒快取的資料競爭" --context-tokens 12000 --requires tools
```

查看 `result.model`、`result.effort` 與 `result.fallbackChain`。這些是供外層程式採用的建議；這個指令本身不執行主模型。

### 選技能

```powershell
luna-core skills --task "使用 rust-testing 補上快取測試"

# 單次指定目錄，也可以重複 --dir
luna-core skills --task "使用 rust-testing 補上快取測試" --dir C:\Users\eda\.agents\skills
```

查看 `result.selected`。每筆包含技能名稱與 `path`；再由 agent 讀取該 `SKILL.md`。明確使用 `/rust-testing` 或完整的連字號專名，會優先納入對應技能。

範例中的 `rust-testing` 需先存在於指定的技能目錄；也可以改成你已安裝的技能名稱。

### 檢索程式碼

```powershell
luna-core retrieve --query "快取淘汰策略在哪裡實作" --root D:\your-project --budget 2000

# 確定要檢索時，可加 --force
luna-core retrieve --query "cache eviction" --root D:\your-project --budget 2000 --force
```

先把實際專案加入第 3 節的 `allowedRoots`。查看 `result.needed`、`result.chunks` 與 `result.tokens`；chunk 會附帶來源與行號。Luna 模式會將候選片段的節錄文字送到決策端點。

### 寫入記憶

```powershell
# 先看決策，暫時不寫入
luna-core remember --text "記住：回答與文件請使用繁體中文" --dry-run

# 依決策新增、更新或略過
luna-core remember --text "記住：回答與文件請使用繁體中文"
```

查看 `result.action`（`save_new`、`update`、`skip`）與 `result.applied`。重複、短暫或疑似秘密的內容可能被略過。

### 讀取記憶

```powershell
luna-core recall --query "回答與文件應該使用什麼語言"
```

查看 `result.memories`。沒有相關記憶時會回傳空清單；規則模式主要依詞彙比對，Luna 可再判斷候選記憶是否適用。

### 壓縮上下文

先建立示範逐字稿；以下只寫入目前資料夾的 `transcript.example.json`：

```powershell
@{
  window = 2000
  goal = "修正快取錯誤"
  force = $true
  segments = @(
    @{ id = "system"; role = "system"; turn = 0; text = "保留使用者要求" },
    @{ id = "old-tool"; role = "tool"; turn = 1; text = ("cache test output line`n" * 500) },
    @{ id = "latest"; role = "user"; turn = 5; text = "繼續修正並確認測試結果" }
  )
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8NoBOM transcript.example.json

luna-core compress --mode heuristic --file .\transcript.example.json
```

查看 `result.compact`、`result.actions`、`result.tokensBefore`、`result.tokensAfter` 與 `result.segments`。有壓縮時，外層程式可以採用 `segments` 作為新上下文。輸入 JSON 檔不會被覆寫；工具也不會直接修改目前 Claude／Codex 對話。

System、pinned 與最近的段落會受到保護，因此不保證每次都能降到目標 token 數。`force` 仍保留這些保護規則。

## 5. 接到 Claude Code 或 Codex

stdio MCP 由宿主啟動工具程序，使用這種接法時不需要先執行 `serve`。以下命令會新增各宿主的 MCP 設定；執行前先完成第 3 節的設定檔。

### Claude Code

在要使用的專案資料夾執行，預設 local scope：

```powershell
claude mcp add luna-core -- node "D:/luna-decision-core/bin/luna-core.js" mcp --config "D:/luna-decision-core/luna-core.config.user.json"
claude mcp list
```

重新開啟 Claude 工作階段後，使用 `/mcp` 查看狀態。`claude mcp add --help` 可查目前版本支援的 scope 與參數。

### Codex

```powershell
codex mcp add luna-core -- node "D:/luna-decision-core/bin/luna-core.js" mcp --config "D:/luna-decision-core/luna-core.config.user.json"
codex mcp list
```

Codex 的 `mcp add` 支援 stdio 啟動命令，MCP 設定儲存在 `~/.codex/config.toml`。本機命令格式已對照已安裝 CLI 的 `--help`；儲存位置與傳輸方式見 [OpenAI 官方文件](https://learn.chatgpt.com/docs/developer-commands#codex-mcp)。新增設定後，重新開啟 Codex 工作階段。

宿主連線完成後，可以請 agent：

```text
請呼叫 luna_route，為「修正快取失效問題並補測試」選擇模型與 effort，先解釋建議結果。
```

六個工具名稱如下；宿主介面可能在名稱前加上 MCP server 前綴：

| 工具 | 用途 |
|---|---|
| `luna_route` | 模型與 effort 建議 |
| `luna_skills` | 選要載入的技能 |
| `luna_retrieve` | 選相關原始碼片段 |
| `luna_remember` | 判斷並寫入記憶 |
| `luna_recall` | 找適用的記憶 |
| `luna_compress` | 判斷並產生壓縮後的段落 |

可將以下操作規則加入自己專案的 `CLAUDE.md` 或 `AGENTS.md`：

```markdown
- 開始任務時呼叫 luna_route，將結果視為模型與 effort 建議；宿主支援時才套用。
- 需要技能時呼叫 luna_skills，再讀取 selected 中的 SKILL.md。
- 需要原始碼脈絡時呼叫 luna_retrieve，依來源與行號使用 chunks。
- 跨任務偏好與約束先透過 luna_recall 查詢；明確要保存的內容交給 luna_remember。
- 上下文接近上限時呼叫 luna_compress，由外層流程決定如何採用回傳段落。
```

## 6. 透過 HTTP 呼叫

第一個 PowerShell 視窗啟動服務：

```powershell
luna-core serve --mode heuristic
```

第二個視窗呼叫：

```powershell
Invoke-RestMethod http://127.0.0.1:8792/health

$body = @{ task = "修正快取錯誤並補測試" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8792/v1/decide/route `
  -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))

Invoke-RestMethod http://127.0.0.1:8792/v1/stats
```

停止時，在服務視窗按 `Ctrl+C`。要使用 Luna，請設好金鑰後改成 `luna-core serve --mode auto`。

其他路徑為 `/v1/decide/skills`、`retrieve`、`memory_write`、`memory_recall`、`compress`，本體欄位見 [README 的函式庫用法](../README.md#8-函式庫用法)。

這些是一般 JSON HTTP 端點，MCP 請使用第 5 節的 stdio 設定。HTTP 服務沒有認證，預設綁定 `127.0.0.1`；決策請求必須使用 JSON content type，所有帶 `Origin` 的瀏覽器請求會被拒絕。

## 7. 看懂結果與紀錄

| 欄位 | 意義 |
|---|---|
| `source: luna` | 使用 Luna 的判斷 |
| `source: luna+rules` | Luna 的判斷經規則調整 |
| `source: rules` | 使用本機規則；auto 降級時另有 `error` 原因 |
| `source: settled` | 已能確定結果，不需要呼叫 Luna |
| `result` | 實際要給外層程式採用的決策 |
| `calls`、`tokens`、`cost` | Luna 成功回覆的呼叫與用量資訊；cost 是未快取價估計上限 |

預設家目錄是 `%USERPROFILE%\.luna-decision-core`：

- `memory.jsonl`：已保存的記憶文字。
- `decisions.jsonl`：決策來源、用量與摘要。
- `config.json`：選用的家目錄設定檔。

CLI 以 exit code `0` 表示成功、`1` 表示執行失敗、`2` 表示指令或輸入用法錯誤。

## 8. 常見問題

| 情況 | 處理方式 |
|---|---|
| `probe: no OpenAI API key` | 檢查套件根目錄 `.env.local`，並用 `config` 確認 apiKey 為 set |
| 想完全離線 | 在子指令後加 `--mode heuristic` |
| auto 模式得到 rules | 查看輸出的 `error`；Luna 失敗或信心不足時會降級 |
| `root ... is outside ...` | 將實際專案加入明確指定設定檔的 `retrieve.allowedRoots` |
| 技能選不到 | 確認 `skills.dirs` 指向技能父目錄，以及 `<技能>/SKILL.md` 存在 |
| MCP 有工具卻沒有自動換模型 | 工具提供建議，換模型由宿主能力或自訂 agent 流程執行 |
| HTTP 403 | 服務拒絕帶 Origin 的瀏覽器請求，請使用伺服器端程式呼叫 |
| HTTP 415 | 設定 `Content-Type: application/json` |
| HTTP 413 | 縮小請求本體至 1 MB 以下 |

MCP stdio 程序與 CLI／HTTP 已有實際程序驗收；Claude Code／Codex 宿主內的完整操作仍需在安裝後確認。本說明沒有代你新增全域 MCP 設定或執行付費 API 呼叫。

完整設定、資料欄位與限制請參閱 [README](../README.md)、[整合指南](integration.md) 與 [驗收紀錄](team/v1/acceptance.md)。
