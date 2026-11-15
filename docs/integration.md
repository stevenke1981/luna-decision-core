# 整合指南（Integration）

luna-decision-core 有三種接法，依你的 harness 選擇：

| 接法 | 適用 | 本文件章節 |
|---|---|---|
| MCP（stdio） | Claude Code、Codex 等支援 MCP 的 agent | 1、2 |
| HTTP sidecar | 能發 HTTP 請求的任何 harness，或多程序共用同一份決策服務 | 3 |
| 函式庫 | 自己就是 Node 程式，想在同一程序內呼叫 | [README 第 8 節](../README.md#8-函式庫用法) |

> 本文件的設定範例尚未在各 harness 的實際版本上執行。標為「未實測」的部分請在你的環境驗證。

## 0. 先決條件

- Node.js ≥ 22.15（`node -v`）。本 repo 零依賴，不需要 `npm install`。
- 記下 CLI 的**絕對路徑**。Windows 上以正斜線書寫最省事，JSON 與 TOML 都接受：`D:/luna-decision-core/bin/luna-core.js`。
- **金鑰不要寫進 MCP 設定檔。** `.mcp.json` 與 `config.toml` 常被提交或分享。請把金鑰放在套件根目錄的 `.env.local`，或 `LUNA_CORE_HOME` 的 `.env.local`（見 [README 第 4 節](../README.md#4-金鑰與-env-檔)）。
- 不想使用金鑰時，設定 `LUNA_CORE_MODE=heuristic`。這時只用規則，不連網。

---

## 1. Claude Code（MCP）

### 1.1 用指令加入

```bash
claude mcp add luna-core -- node "D:/luna-decision-core/bin/luna-core.js" mcp
```

`--` 之後是要執行的指令。預設（local）scope 只對目前專案與你的帳號生效，不會進入 Git。若要隨專案共享，請加上 `--scope project`，它會寫入專案根目錄的 `.mcp.json`（未實測）。

確認已連上：

```bash
claude mcp list
```

也可以在 Claude Code 內輸入 `/mcp` 查看狀態。

### 1.2 `.mcp.json` 範例

專案根目錄的 `.mcp.json`：

```json
{
  "mcpServers": {
    "luna-core": {
      "command": "node",
      "args": ["D:/luna-decision-core/bin/luna-core.js", "mcp"],
      "env": {
        "LUNA_CORE_MODE": "auto"
      }
    }
  }
}
```

只用規則時，把 `LUNA_CORE_MODE` 改為 `heuristic`。`env` 區塊只放設定值，不要放金鑰。

### 1.3 讓 Claude Code 實際使用

MCP 工具只回傳決策。Claude Code 不會因為工具存在而自動換模型或載入 skill，agent 必須呼叫工具，並依結果行事。建議在專案的 `CLAUDE.md` 加入這類指引（工具名稱在 Claude Code 中通常顯示為 `mcp__luna-core__luna_route` 這類形式）：

```markdown
## luna-core 決策層
- 開始新任務時呼叫 `luna_route`，把 `result.model` 與 `result.effort` 當作本輪的建議。
- 需要某個 skill 時呼叫 `luna_skills`，再讀取 `result.selected[].path` 指向的 SKILL.md。
- 需要過去記憶時呼叫 `luna_recall`；只在得到耐久、非秘密的事實時呼叫 `luna_remember`。
- 上下文接近上限時呼叫 `luna_compress`，依結果保留、摘要或丟棄段落。
- 不要把金鑰、密碼或權杖放進任何工具參數。
```

`result.model` 是建議。若要真的換模型，仍由使用者或 harness 處理。

### 1.4 驗證

1. `claude mcp list` 顯示 `luna-core` 已連上。
2. 請 agent 呼叫一次 `luna_route`。
3. 檢查 `<home>/decisions.jsonl`（預設 `~/.luna-decision-core/decisions.jsonl`）是否新增一行。

---

## 2. Codex（MCP）

Codex 的設定檔為 `$CODEX_HOME/config.toml`（預設 `~/.codex/config.toml`）。在檔案中加入：

```toml
[mcp_servers.luna-core]
command = "node"
args = ["D:/luna-decision-core/bin/luna-core.js", "mcp"]

[mcp_servers.luna-core.env]
LUNA_CORE_MODE = "auto"
```

注意：這不是 `luna-decision-openai` 的 `luna-decision.config.toml`。兩者是不同的專案，請不要互相覆寫。

把 `LUNA_CORE_MODE` 改為 `heuristic` 可只用規則。金鑰仍請放在 `.env.local`。

在專案的 `AGENTS.md` 加入與第 1.3 節相同的使用指引，Codex 會讀取它。

未實測：Codex 的 MCP 設定欄位與工具名稱依版本而異，請以你安裝的版本文件為準。

---

## 3. 通用 agent 迴圈（HTTP sidecar）

### 3.1 啟動

```bash
luna-core serve                 # 127.0.0.1:8792 by default
curl -s http://127.0.0.1:8792/health
```

sidecar 是單一程序。**沒有身分驗證**，保持綁定 loopback（`server.host` 預設 `127.0.0.1`），不要對外開放。

HTTP 呼叫端必須送出 `Content-Type: application/json`。服務拒絕所有帶有 `Origin` 標頭的請求（403），供 CLI、MCP 與伺服器端 harness 使用。`server.host` 只能由家目錄或明確指定的設定檔變更。

### 3.2 端點

| 方法與路徑 | 用途 |
|---|---|
| `POST /v1/decide/route` | 選模型與 effort |
| `POST /v1/decide/skills` | 選要載入的 skill |
| `POST /v1/decide/retrieve` | 選相關 chunk |
| `POST /v1/decide/memory_recall` | 找適用的記憶 |
| `POST /v1/decide/memory_write` | 判斷並（預設）寫入記憶 |
| `POST /v1/decide/compress` | 判斷要壓縮哪些段落 |
| `GET /v1/stats`、`GET /health` | 統計與健康檢查 |

路徑中的 kind 是 `memory_recall` 與 `memory_write`，不是 MCP 的 `luna_recall` 與 `luna_remember`。請求本體欄位與 [README 第 8 節](../README.md#8-函式庫用法) 相同（camelCase）。

### 3.3 流程（pseudo-flow）

```text
route → skills → recall → retrieve → act → remember → compress

on a new user request:
  r = POST /v1/decide/route         { task, contextTokens }
      use r.result.model and r.result.effort for this turn
  s = POST /v1/decide/skills        { task }
      read SKILL.md at each s.result.selected[i].path into the context
  m = POST /v1/decide/memory_recall { query: task, limit }
      add m.result.memories[i].text to the context
  x = POST /v1/decide/retrieve      { query: task, root: repoRoot, budgetTokens }
      add x.result.chunks[i].text (source, startLine-endLine) to the context

repeat until the task is done:
  act:      one model generation at r.result.effort, plus tool calls
  record:   the step as { kind, command, failed }
  if a step failed or the work got harder:
      r = POST /v1/decide/route { task, steps: recentSteps, contextTokens }
  if a durable fact appeared (a user preference, a decision, a constraint):
      POST /v1/decide/memory_write { observation, source: "agent" }
      (stored unless dryRun; result.action is save_new | update | skip)
  if contextTokens / window >= 0.6:
      c = POST /v1/decide/compress { window, segments, goal }
      apply c.result.actions (keep | summarize | drop), or use c.result.segments
      when it is non-null
```

### 3.4 Node 呼叫端範例

```js
const BASE = 'http://127.0.0.1:8792';
const TIMEOUT_MS = 2000; // the caller's own limit; on failure use the harness default

export async function decide(kind, input) {
  const res = await fetch(`${BASE}/v1/decide/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status}`);
  return res.json();
}

const route = await decide('route', { task: 'Fix the failing login test', contextTokens: 8000 });
console.log(route.result.model, route.result.effort, route.source);
```

### 3.5 錯誤與降級

| 狀態碼 | 意義 | 呼叫端建議 |
|---|---|---|
| `200` | 成功。在 `auto` 模式下，Luna 出錯時仍回 200，並以規則結果回傳，`error` 欄位說明原因 | 讀取 `error`，記錄為降級 |
| `400` | JSON 格式錯誤，或輸入不合法（`TypeError`） | 修正請求，不要重試同一筆 |
| `403` | 請求帶有瀏覽器 `Origin` 標頭 | 從伺服器端 harness 呼叫服務 |
| `404` | 未知路徑（例如未知 kind） | 修正路徑 |
| `413` | 請求本體超過 1 MB | 縮小輸入 |
| `415` | Content-Type 不是 `application/json` | 設定 JSON content type |
| `502` | 嚴格（`luna`）模式下 Luna 出錯 | 改用本機規則或 harness 的預設值 |
| `500` | 本機 IO 等其他錯誤（strict 模式也適用） | 記錄後使用 harness 的預設值 |

sidecar 無法連線時，harness 應使用自己的預設值繼續執行，不要因此中止任務。

---

## 4. 選擇建議

| 情境 | 建議接法 |
|---|---|
| Claude Code 或 Codex，只需要工具呼叫 | MCP（第 1、2 節） |
| 多個 harness 共用同一份決策服務與 ledger | HTTP sidecar（第 3 節） |
| 自己寫 Node agent，想在程序內決定 | 函式庫（README 第 8 節） |
| 離線或不想付費 | `LUNA_CORE_MODE=heuristic` |

## 5. 接線後的檢查清單

- [ ] `luna-core config` 印出的有效設定中，沒有金鑰。
- [ ] `luna-core route --task "rename a variable in one file"` 回傳一筆 Decision（heuristic 模式下 `source` 為 `rules`）。
- [ ] `decisions.jsonl` 在決策後新增一行，且沒有任務原文。
- [ ] MCP 設定檔與 `AGENTS.md`／`CLAUDE.md` 中沒有任何金鑰。

## Codex generation routing

Use `examples/codex.config.json` as the routing catalog and
`examples/codex-route.json` as a sample request. The context windows and effort
allowlists in the example are policy settings. Set them for your own executor.

```sh
node bin/luna-core.js route --config examples/codex.config.json --input-json examples/codex-route.json
```

The same request object works with `engine.route(input)`, HTTP
`POST /v1/decide/route`, and the MCP tool `luna_route`.

1. Read Codex App Server `model/list` for the active executor and follow all
   `nextCursor` pages. Map each visible entry's `id` and
   `supportedReasoningEfforts[].reasoningEffort` to `availableModels`.
   An empty list means that no configured model can run on this executor.
2. Send generation outcomes in `attempts` from oldest to newest. Record the
   model and effort actually used. Give each generation one unique `attemptId`.
   Use `pending` for in-flight work. A success resets the failure history used
   for escalation. Pass `attempts: []` for a new task. Older clients may omit
   `attempts` to keep step-based escalation.
3. Apply `result.model` and `result.effort` on the next Codex turn using the
   executor's model and effort controls. Confirm the effective configuration
   before recording the next attempt. The route result itself is a recommendation.

With the sample catalog, a fresh task starts on Sol at medium effort. The first
failure retries that pair, the second raises to high on Sol, and a failure at
that raised effort promotes to Astra at high. Promotion checks higher tiers in
ascending order and keeps the required effort floor. A starting or retry
decision resolved by policy skips the Luna request. For discretionary decisions,
Luna receives only eligible models and the model question is omitted when one
model is eligible.

The SDK throws an error with `code` for classified decision failures. HTTP and
MCP expose `errorCode`, and CLI diagnostics end with the same code in brackets.
HTTP uses 400 for `NO_ELIGIBLE_MODEL`, 422 for `ESCALATION_EXHAUSTED`, and 502 for
strict Luna failures. Auto-mode upstream fallback includes `error` and
`errorCode` on the successful rules result. Expected upstream codes include
`LUNA_AUTH`, `LUNA_TIMEOUT`, `LUNA_RATE_LIMIT`, `LUNA_HTTP`, `LUNA_TRANSPORT`,
`LUNA_MALFORMED_ANSWER`, `LUNA_REFUSED`, and `LUNA_LOW_CONFIDENCE`.
Luna route verdicts also expose `result.lunaSelection` with the original
suggestion, reported confidence, and the probability of each selected option
when available. These fields describe Luna's suggestion before rules or
executor effort matching.

[Codex App Server model discovery and turn controls](https://learn.chatgpt.com/docs/app-server)

## 6. Codex 原生 hook：每次提示前強制決策

MCP 註冊與 `AGENTS.md` 指引不會自動呼叫工具。需要每次使用者提示送出前都執行 Luna 時，可使用同步的 `UserPromptSubmit` command hook。事件與信任規則以 [Codex hooks 官方文件](https://learn.chatgpt.com/docs/hooks)為準。

### 6.1 產生並安裝設定

在 luna-decision-core 目錄執行（Node.js 須可執行）：

```sh
node bin/luna-core.js hook-config --config /absolute/path/to/your/config.json
```

`--config` 可省略，省略時使用既有設定搜尋規則。可重複傳入 `--dir /absolute/path/to/skills` 覆蓋技能目錄；否則使用設定中的 `skills.dirs`。請在設定中列出該 host 真正可用的 `route.models`。

把輸出的 JSON 存到**欲套用專案**的 `.codex/hooks.json`；若已存在，僅合併 `hooks.UserPromptSubmit`，保留其他 hooks。產生指令只輸出設定，不覆寫檔案、不輸出金鑰，也不呼叫 API。設定包含本機 Node、CLI 與選項的絕對路徑，換電腦或移動工具後須重新產生；不要把這份本機設定提交到公開儲存庫。

在 Codex CLI 執行 `/hooks` 檢查並信任，或在桌面版 Settings > Hooks 審查。hook 程序須能從環境或 env 檔讀到金鑰；若只在 Windows 使用者環境變數設定，已開啟的 Codex 可能需重新啟動才會繼承。未信任、hooks 被停用、專案未被信任或 host 不支援時，不代表已強制啟用。不要用略過 hook 信任的參數替代審查。

Windows 設定使用 `commandWindows` 及 PowerShell `-EncodedCommand`，避免 Node 路徑空白、單引號與 Unicode 造成巢狀 shell 引號錯誤；編碼只包含可執行檔、CLI 路徑與明示選項，不含金鑰或提示。審查時可將最後的 Base64 參數解碼：

```powershell
[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('<EncodedCommand 的參數>'))
```

### 6.2 執行與失敗行為

- hook 由 host 同步執行，從 stdin 讀取 `UserPromptSubmit` JSON，先做 `route`，再做 `skills`，完成後才回傳 developer context。
- 固定使用 `luna` 嚴格模式，並在此 hook 內停用 `route.start` 固定起始策略以確保路由詢問 Luna（一般路由不變）；覆蓋設定及環境中的 `auto`／`heuristic`；明示傳入 `--mode auto` 或 `--mode heuristic` 會被阻擋。
- 沒有金鑰、上游錯誤、低信心棄權、設定／輸入錯誤或技能決策失敗時，回傳 exit 0 與 `{"decision":"block","reason":"..."}`，由 Codex 阻擋提示。exit 0 表示 hook 回應格式有效，不表示決策通過。
- 路由會呼叫 API；沒有技能候選時，技能決策可直接得到 `settled`，不額外花費。輸入限制為 1 MB。設定的 host timeout 為 30 秒，若自訂 API timeout 或技能批次較大，需一併調整。
- 成功時將路由與技能結果加入 `hookSpecificOutput.additionalContext`，要求 agent 讀取選中的 `SKILL.md`。模型切換及決策採納仍由 host／agent 負責，hook 不變更模型、不擴大權限，也不攔截每次工具呼叫。
- 每次正常提示都可能產生 OpenAI API 費用。這不是費用上限功能；請使用 API 專案的預算／用量管理。hook 程序無法啟動、逾時或遭 host 略過時，host 可能繼續，不能當成不可繞過的安全邊界。

### 6.3 驗證與移除

```sh
node --test test/hook.test.js
```

測試使用假 transport、獨立臨時目錄及無金鑰子程序，不會呼叫 OpenAI。實際驗證時，先確認 `/hooks` 顯示已信任，再送出簡短提示，確認提示前有 `Running Luna Decision`，並在 ledger 檢查新的 `route`／`skills` 決策。缺少金鑰時應得到阻擋訊息。

移除時，只刪除 `.codex/hooks.json` 中本工具對應的 handler；保留同檔其他 hooks，並在 `/hooks` 確認已卸載。不要刪除共用 API 金鑰或修改全域 MCP 設定。
