# luna-decision-core

One decision layer for coding-agent harnesses. OpenAI's Luna (`gpt-6-luna`, Decisions API) answers six kinds of small, typed questions; local rules gate every answer and, in `auto` mode, take over when Luna is unavailable, abstains, or fails.

中文說明：給 coding agent 用的決策層。OpenAI Luna 透過 Decisions API 回答六類小問題（選模型與 effort、載入哪些 skill、要不要檢索及哪些 chunk 相關、哪些記憶適用、要記住什麼、何時壓縮上下文）。本地規則把關每個答案；在 `auto` 模式下，Luna 不可用、棄權或失敗時，由規則接手。

> 與 `luna-decision-openai`（Codex 用的本機 proxy）不同。本 repo 是可被 harness 呼叫的函式庫、CLI、HTTP sidecar 與 MCP server。

> **驗證狀態（2026-11-05）**：Windows 上 Node 22.15.0 與 24.20.0 各通過 391 個測試；實際 CLI、HTTP 與 MCP stdio 程序已完成離線驗收。完整範圍與未執行項目見 [驗收紀錄](docs/team/v1/acceptance.md)。範例中的耗時與模型機率僅供示意。

Node.js ≥ 22.15，ESM，**零依賴**（`package.json` 沒有 dependencies，不需要 `npm install`）。

## 目錄

1. [這是什麼](#1-這是什麼)
2. [Luna 與規則如何合作](#2-luna-與規則如何合作)
3. [快速開始](#3-快速開始)
4. [金鑰與 env 檔](#4-金鑰與-env-檔)
5. [CLI 參考](#5-cli-參考)
6. [HTTP API 參考](#6-http-api-參考)
7. [MCP](#7-mcp)
8. [函式庫用法](#8-函式庫用法)
9. [設定](#9-設定)
10. [費用](#10-費用)
11. [紀錄與隱私](#11-紀錄與隱私)
12. [已知限制](#12-已知限制)
13. [開發](#13-開發)
14. [授權](#14-授權)

## 1. 這是什麼

| kind | 問的是什麼 | Luna 題型 | CLI | MCP tool | 函式庫 `engine.*` |
|---|---|---|---|---|---|
| `route` | 用哪個模型、多少 reasoning effort | choice `model` + score `effort` | `route` | `luna_route` | `route(input)` |
| `skills` | 載入哪些 skill | 每個候選 skill 一題 predicate | `skills` | `luna_skills` | `skills(input)` |
| `retrieve` | 要不要檢索，哪些 chunk 相關 | predicate `need_retrieval` + 每個 chunk 一題 | `retrieve` | `luna_retrieve` | `retrieve(input)` |
| `memory_recall` | 哪些已存的記憶適用 | 每個候選記憶一題 predicate | `recall` | `luna_recall` | `recall(input)` |
| `memory_write` | 存、更新或略過；類型；更新哪一筆 | choice `action`、`type`、`target` + predicate `durable` | `remember` | `luna_remember` | `remember(input)` |
| `compress` | 現在要不要壓縮；每段保留、摘要或丟棄 | predicate `compact_now` + 每段一題 choice | `compress` | `luna_compress` | `compress(input)` |

Library 呼叫 `engine.decide(kind, input)` 時，kind 名稱為 `route`、`skills`、`retrieve`、`memory_recall`、`memory_write`、`compress`（HTTP 路徑也用同樣的名稱）。

每次決策都回傳同一種形狀的 Decision；`source` 說明結果來自哪裡（見第 2 節）。

## 2. Luna 與規則如何合作

### 模式（`mode`）

| mode | 行為 | 需要金鑰 | 會連網 |
|---|---|---|---|
| `auto`（預設） | 先問 Luna。Luna 出錯或棄權，改用規則，並在 decision 的 `error` 寫明原因 | 是；沒有金鑰時每次都退回規則 | 是 |
| `luna` | 嚴格模式。Luna 出錯或棄權，decision 直接失敗（先寫入 ledger，再拋出錯誤）。不會偷偷換成規則 | 是 | 是 |
| `heuristic` | 只用規則，不呼叫 Luna | 否 | 否 |

### 決策流程

1. `normalize`：檢查輸入。輸入不合法拋出 `TypeError`，不會退回規則。
2. `prepare`：做 IO，例如掃描 skill 目錄、搜尋 repo 索引、搜尋記憶。
3. `plan`：若規則已能決定（settled，例如沒有候選 chunk），不呼叫 Luna。
4. 呼叫 Luna，依答案 `interpret`。若 Luna 的信心低於 `minConfidence`，即棄權。
5. `gate`：規則可以把關 Luna 的結果。目前只有 `route` 與 `compress` 定義了 gate。
6. 任何 Luna 錯誤：`luna` 模式失敗；`auto` 模式改用規則。
7. `finalize`：`memory_write` 寫入記憶（dry run 與 skip 不寫）；`compress` 套用壓縮。
8. 寫入 ledger（一行 JSON），回傳 Decision。

### 棄權、把關與退回

- **棄權（abstain）**：Luna 的主要答案信心低於 `minConfidence`（預設 `0.4`）時，視為一次失敗。`auto` 退回規則；`luna` 模式則 decision 失敗。
- **把關（gate）**：`route` 在最近的步驟以失敗結束時（連續失敗至少一次），取 Luna 與規則中較高的 tier 與 effort（有變動時 `source` 為 `luna+rules`）；`compress` 會把 Luna 的結果逐段升級，直到用量降到 `targetRatio` 以下。
- **退回（fallback）**：`auto` 模式下，網路錯誤、逾時、HTTP 錯誤、棄權與答案格式錯誤，都改由規則產生結果，`source` 為 `rules`，`error` 保留原因。失敗後 Luna 會暫停一段時間（見第 10 節）。
- **不退回**：`normalize` 的輸入錯誤，以及 `prepare` 的 IO 錯誤（例如 SKILL.md 無法讀取），在所有模式下都讓 decision 失敗。

### Decision 形狀

```json
{
  "kind": "route",
  "source": "rules",
  "result": {
    "model": "claude-sonnet-5-5",
    "effort": "high",
    "fallbackChain": ["claude-opus-5-5"],
    "modelProbabilities": null,
    "effortProbabilities": null
  },
  "confidence": null,
  "reasons": ["first failure; hard or long task", "model claude-sonnet-5-5"],
  "cost": null,
  "tokens": null,
  "calls": 0,
  "latencyMs": 1
}
```

上例為 heuristic 模式實測輸出（`latencyMs` 每次不同）。`source` 的值：`settled`、`luna`、`rules`、`luna+rules`。`error` 欄位只在 `auto` 模式退回規則時出現。

### 送出與不送出的內容

**會送到 Decisions 端點的內容**（預設為 OpenAI；每段都先截斷）：

- `route`：任務文字（前 2000 字）、最近 8 步的 kind、指令（前 160 字）與狀態、context tokens、候選模型的 id、tier 與 strengths。
- `skills`：任務文字（前 2000 字）、候選 skill 的 name 與 description（前 300 字）。
- `retrieve`：查詢（前 2000 字），候選 chunk 的來源路徑與行號、文字（前 600 字）。**repo 原始碼片段會送出。**
- `memory_recall`：查詢（前 2000 字），候選記憶的 type 與文字（前 400 字）。
- `memory_write`：觀察內容（前 1000 字）、source、相似記憶的 type 與文字（前 400 字）。
- `compress`：目標（前 1000 字）、各段的 role、年齡、tokens 與文字（前 400 字），不會送完整逐字稿。

**不會送出，或已被擋下的內容**：

- **API 金鑰**只放在送往端點的 `Authorization` 標頭，不進入 state、ledger 或 `config` 輸出。
- **疑似秘密的字串**在每份 state 送出前都經過 `redactDeep`，符合樣式的片段會被換成 `[redacted]`。若 `memory_write` 的觀察內容疑似秘密，直接 skip，不呼叫 Luna，文字也不進入 state。記憶庫也拒絕儲存這類文字。
- **ledger 不含使用者文字**（見第 11 節）。
- **索引之外的檔案**：符號連結、`.git` 等被忽略的資料夾、二進位檔、超過 `maxFileBytes` 的檔案、副檔名不在清單內的檔案。

注意：redaction 是樣式比對，不是保證。它涵蓋 PEM 私鑰區塊、`sk-`、`sk-or-`、`gh[pousr]_`、`github_pat_`、`glpat-`、`xox[abpr]-`、`AKIA`、`AIza`、Bearer token 與 JWT、`scheme://user:pass@` 形式的網址帳密，以及 `password`、`secret`、`token`、`api_key`、`access_key`、`client_secret`、`auth` 等鍵名（含 `DB_PASSWORD`、`"apiKey"` 這類前綴與引號寫法）後接 `:` 或 `=` 的指派。不要把秘密放進任務、查詢或觀察內容。

**設定檔的信任分層**：`luna.url`、`memory.path`、`ledger.path`、`skills.dirs`、`retrieve.allowedRoots`、`server.host` 只接受來自 `--config`／`LUNA_CORE_CONFIG` 指定的檔案或家目錄設定（`<home>/config.json`）；寫在工作資料夾的 `luna-core.config.json` 會直接報錯，避免陌生專案把金鑰導向別處、讀取任意資料夾或改變服務的網路範圍。`luna.url`（含 `LUNA_DECISION_URL`）必須是 `https:`，或指向 `127.0.0.1`／`localhost`。Luna 回傳的錯誤訊息中，金鑰原文會換成 `[key]`。

## 3. 快速開始

Heuristic 模式不需要金鑰，可以先跑通。

```powershell
# Get the public repository first, if needed:
git clone https://github.com/stevenke1981/luna-decision-core.git
cd luna-decision-core

# Windows PowerShell, in D:\luna-decision-core (the repository folder)
npm link                                    # once: registers the luna-core command
luna-core --version
$env:OPENAI_API_KEY = "sk-..."              # this window only; or use .env.local (see section 4)
luna-core probe                             # one live gpt-6-luna call: checks the key and the call shape

$env:LUNA_CORE_MODE = "heuristic"           # rules only: no key, no network
luna-core route --task "rename a variable in one file"
Remove-Item Env:LUNA_CORE_MODE              # back to auto
```

```bash
# bash, in the repository folder
npm link                                    # once: registers the luna-core command
luna-core --version
export OPENAI_API_KEY=sk-...
luna-core probe

LUNA_CORE_MODE=heuristic luna-core route --task "rename a variable in one file"
```

`probe` 會實際呼叫一次 `gpt-6-luna`，印出決策、費用與 token 數。沒有金鑰時會報錯並以 exit 1 結束（已用實際 CLI 程序驗證）。本次驗收環境沒有可用金鑰，未重跑付費 API 呼叫。

示意輸出（CLI 已驗證此形狀，耗時每次不同）：

```json
{ "kind": "route", "source": "rules", "result": { "model": "claude-haiku-5-5", "effort": "medium", "fallbackChain": ["claude-sonnet-5-5", "claude-opus-5-5"], "modelProbabilities": null, "effortProbabilities": null }, "confidence": null, "reasons": ["routine task", "model claude-haiku-5-5"], "cost": null, "tokens": null, "calls": 0, "latencyMs": 0 }
```

若 `npm link` 之後找不到 `luna-core` 指令，請重新開啟終端機。

## 4. 金鑰與 env 檔

Luna 的呼叫費用計入你的 OpenAI API 金鑰。金鑰只從環境變數或 env 檔讀取，不能寫進 JSON 設定檔（設定檔含 `apiKey` 會直接報錯）。

優先順序（先找到者勝出，已設定且非空的 shell 變數永遠優先）：

| 順序 | 來源 | 位置 |
|---|---|---|
| 1 | shell／系統環境變數 | — |
| 2 | 套件資料夾的 `.env.local`，再 `.env` | 本 repo 根目錄（**不是**你正在工作的專案資料夾） |
| 3 | `LUNA_CORE_HOME` 的 `.env.local`，再 `.env` | 預設 `~/.luna-decision-core/` |

- env 檔只讀取 `LUNA_*` 與 `OPENAI_*` 變數；檔案中的其他變數不會被載入。
- `.env.local` 與 `.env` 已列入 `.gitignore`。範本是 `.env.example`（可提交，所有值都被註解掉）。
- 檔案開頭的 UTF-8 BOM 會被忽略；檔案存在但讀不到時回報警告，不會中止。
- `LUNA_CORE_HOME` 請設在 shell 中，不要設在 env 檔裡，否則 env 檔的查找位置與記憶、紀錄的位置會不一致。

```powershell
Copy-Item .env.example .env.local    # then edit .env.local
```

```bash
cp .env.example .env.local           # then edit .env.local
```

## 5. CLI 參考

CLI 啟動時會先讀取 env 檔。輸出為 JSON 寫到 stdout；錯誤寫到 stderr。Exit code：`0` 成功、`1` 執行錯誤、`2` 用法錯誤。

| 指令 | 用途 | 參數 |
|---|---|---|
| `luna-core probe` | 呼叫一次 Luna（route 的固定任務），印出決策、費用與 token。需要金鑰 | — |
| `luna-core route` | 選模型與 effort | `--task T`、`--context-tokens N`、`--requires a,b`、`--local-only` |
| `luna-core skills` | 選要載入的 skill | `--task T`、`--dir D`（可重複） |
| `luna-core retrieve` | 選相關 chunk | `--query Q`、`--root R`、`--budget N`、`--force` |
| `luna-core recall` | 找適用的記憶 | `--query Q` |
| `luna-core remember` | 判斷要不要存、更新哪一筆記憶 | `--text T`、`--source user`、`--dry-run` |
| `luna-core compress` | 判斷要壓縮哪些段落 | `--file transcript.json`（完整 input 物件的 JSON） |
| `luna-core serve` | 啟動 HTTP sidecar，預設 `127.0.0.1:8792` | `--port N` |
| `luna-core mcp` | 啟動 MCP stdio server | — |
| `luna-core config` | 印出有效設定（不含金鑰） | — |
| 全域旗標 | `--mode auto\|luna\|heuristic`、`--config FILE`、`--version`、`--help` | — |

CLI 範例：

```bash
luna-core skills --task "Use /rust-testing to add unit tests" --dir ./skills
luna-core retrieve --query "where is evictCache defined" --root . --budget 2000
luna-core remember --text "Always run npm test before committing" --dry-run
luna-core compress --file ./transcript.json
luna-core config
```

## 6. HTTP API 參考

HTTP sidecar 是單一 Node 程序，預設綁定 `127.0.0.1:8792`（`server.host`、`server.port` 或 `--port` 可改）。**本服務沒有身分驗證**，請保持綁定在 loopback，不要對外網開放。

| 方法與路徑 | 說明 |
|---|---|
| `GET /health` | 回傳 `{ok, version, mode}` |
| `POST /v1/decide/:kind` | 請求本體為該 kind 的輸入 JSON（欄位與第 8 節相同）；回傳 Decision。`:kind` 為 `route`、`skills`、`retrieve`、`memory_recall`、`memory_write`、`compress` 之一 |
| `GET /v1/stats` | 回傳 `engine.stats()` 的副本 |

決策請求必須帶 `Content-Type: application/json`（可加 `charset`）。服務供 CLI 與 harness 使用，拒絕所有帶有 `Origin` 標頭的瀏覽器請求，避免跨來源網頁寫入記憶或消耗 Luna 額度。

錯誤狀態碼：`400` 為 JSON 格式錯誤或輸入不合法；`403` 為帶有 `Origin` 的請求；`404` 為未知路徑；`413` 為本體超過 1 MB；`415` 為非 JSON content type；`502` 為嚴格模式下 Luna 出錯；`500` 為本機 IO 等其他錯誤（strict 模式也一樣）。

HTTP 範例：

```bash
curl -s http://127.0.0.1:8792/health

curl -s -X POST http://127.0.0.1:8792/v1/decide/route \
  -H 'content-type: application/json' \
  -d '{"task":"Refactor the retry logic in src/http/client.js and keep the tests green","steps":[{"kind":"exec","command":"npm test","failed":true}],"contextTokens":12000}'

curl -s -X POST http://127.0.0.1:8792/v1/decide/memory_write \
  -H 'content-type: application/json' \
  -d '{"observation":"Always run npm test before committing","dryRun":true}'

curl -s http://127.0.0.1:8792/v1/stats
```

PowerShell 示意：

```powershell
Invoke-RestMethod http://127.0.0.1:8792/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8792/v1/decide/route `
  -ContentType 'application/json' -Body '{"task":"Refactor the retry logic in src/http/client.js"}'
```

## 7. MCP

`luna-core mcp` 以 stdio 說 JSON-RPC 2.0（每行一則 JSON，協定版本 `2025-06-18`）。stdout 只會有 JSON-RPC；診斷訊息寫到 stderr。

支援的方法：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`。

| tool | kind | 參數 |
|---|---|---|
| `luna_route` | `route` | 同第 8 節 route 輸入 |
| `luna_skills` | `skills` | 同 skills 輸入 |
| `luna_retrieve` | `retrieve` | 同 retrieve 輸入 |
| `luna_recall` | `memory_recall` | 同 memory_recall 輸入 |
| `luna_remember` | `memory_write` | 同 memory_write 輸入 |
| `luna_compress` | `compress` | 同 compress 輸入 |

每個 tool 的 JSON schema 是封閉的（`additionalProperties: false`），可由 `tools/list` 取得。結果為 `content: [{type: "text", text: <JSON>}]`；失敗時 `isError: true`。

Claude Code 與 Codex 的設定方式見 [`docs/integration.md`](docs/integration.md)。最短的 Claude Code 指令：

```bash
claude mcp add luna-core -- node "D:/luna-decision-core/bin/luna-core.js" mcp
```

MCP tool 只回傳決策。harness 本身不會因此自動換模型，是否套用答案由使用者或 agent 決定。

## 8. 函式庫用法

Node ESM。`npm link` 之後可直接用套件名稱匯入；否則請用絕對路徑。

```js
import { loadEnvFiles } from 'luna-decision-core/src/envfile.js';
import { loadConfig } from 'luna-decision-core/src/config.js';
import { createEngine } from 'luna-decision-core/src/engine.js';

loadEnvFiles();                                     // optional: .env.local, .env, LUNA_CORE_HOME
const config = loadConfig({ overrides: { mode: 'auto' } });
const engine = createEngine({ config });

const route = await engine.route({
  task: 'Refactor the retry logic in src/http/client.js and keep the tests green',
  steps: [{ kind: 'exec', command: 'npm test', failed: true }],
  contextTokens: 12000,
});
console.log(route.result.model, route.result.effort, route.source);

const recalled = await engine.recall({ query: 'retry policy', limit: 3 });
const written = await engine.remember({ observation: 'Always run npm test before committing', source: 'user', dryRun: true });
console.log(recalled.result.memories.length, written.result.action, engine.stats().decisions);
```

- `loadConfig` 不會讀取 env 檔；要讀取時先呼叫 `loadEnvFiles()`（它會寫入 `process.env`，只補上未設定的變數）。
- `createEngine({ config, transport?, kinds?, deps?, ledger? })`：`transport` 可注入假的 Luna（測試用）；`deps` 可注入 `store`、`loadCatalog`、`repoIndex`。
- `engine.stats()` 回傳 `{decisions, lunaCalls, cost, fallbacks, errors, byKind}` 的副本。
- `engine.decide(kind, input)` 是通用入口；未知 kind 拋出 `TypeError`。
- 輸入欄位（camelCase；CLI 旗標為對應的 kebab-case）：

| kind | 必要欄位 | 選用欄位 |
|---|---|---|
| `route` | `task` | `steps`（`{kind: read\|edit\|verify\|exec\|tool, command, failed: boolean\|null}`）、`contextTokens`、`requires`、`localOnly`、`candidates` |
| `skills` | `task` | `catalog`、`dirs`、`maxSkills` |
| `retrieve` | `query` | `root`（掃描並建立索引）或 `candidates`（`{id, source, text, startLine, endLine, score}`）；兩者皆無時 settled 為不需檢索；另有 `budgetTokens`、`force` |
| `memory_recall` | `query` | `limit` |
| `memory_write` | `observation` | `source`（`user`、`agent`、`tool`）、`type`（`user`、`feedback`、`project`、`reference`）、`dryRun` |
| `compress` | `window`（正整數）、`segments` | `goal`、`force`；segment 為 `{id, role, text, turn, tokens?, pinned?}` |

## 9. 設定

### 優先順序與設定檔

`DEFAULTS` → 設定檔 → 環境變數 → 程式呼叫的 `overrides`。後者覆蓋前者。

- **物件**逐欄合併；**陣列與純量**整個取代。因此 `route.models` 要列出完整清單，只寫新增的模型會把內建三個模型全部丟掉。
- 設定檔位置（先找到者勝出）：`loadConfig({ file })`，或環境變數 `LUNA_CORE_CONFIG`（指定時找不到會報錯）；否則為目前工作目錄的 `luna-core.config.json`，再來是 `<home>/config.json`。
- 設定檔內的 `apiKey`（或 `luna.apiKey`）會被拒絕。
- 相對路徑（`skills.dirs`、`memory.path`、`ledger.path`）以執行時的工作目錄為準。

範例設定檔見 [`luna-core.config.example.json`](luna-core.config.example.json)：在內建的 Claude 模型旁加入三個 GPT 模型。

```bash
node --input-type=module -e "import {loadConfig} from './src/config.js'; loadConfig({file:'luna-core.config.example.json'}); console.log('ok')"
```

**示意值**：範例中的 `tier`、`contextWindow`、`strengths` 與 `efforts` 都是示意，請依你自己的評測改寫。`gpt-6.1-sol` 與 `gpt-6-astra` 的 `efforts` 只列到 `xhigh`，因為 `max` 對這兩個模型尚未實測；確認後再加上 `max`。在目前設定下，若 route 判定需要 `max`，這兩個模型會被夾到 `xhigh`（最接近的支援級；已用 heuristic 模式驗證）。`tier` 決定模型的排序（較便宜、較弱者在前）。

### 內建設定（`DEFAULTS`）

| 鍵 | 預設 | 意義 |
|---|---|---|
| `mode` | `auto` | `auto`、`luna`、`heuristic`（見第 2 節） |
| `minConfidence` | `0.4` | Luna 信心低於此值即棄權，改用規則（0 到 1） |
| `ladder` | `["low","medium","high","xhigh","max"]` | effort 階梯，由低到高，2 到 10 級，不可重複 |
| `luna.url` | `https://api.openai.com/v1/decisions` | Decisions API 端點 |
| `luna.model` | `gpt-6-luna` | 決策模型 |
| `luna.timeoutMs` | `4000` | 單次呼叫逾時（正整數，毫秒） |
| `luna.cacheMode` | `explicit` | `explicit`（標記 cache breakpoint）、`implicit`、`off` |
| `luna.maxQuestionsPerCall` | `16` | 每次呼叫最多幾題，超過則分批（見第 10 節） |
| `route.effortQuantile` | `0.5` | 取 Luna effort 分布的哪個分位數（0 到 1） |
| `route.modelQuantile` | `0.5` | 取 Luna 模型分布的哪個分位數，模型依 tier 排序 |
| `route.contextHeadroom` | `1.2` | 模型的 contextWindow 須 ≥ contextTokens × 此值才合格 |
| `route.models` | 見下表 | 候選模型清單 |
| `skills.dirs` | `[]` | 掃描 `<dir>/<skill>/SKILL.md` 的資料夾清單 |
| `skills.shortlist` | `12` | BM25 先取前幾名給 Luna 判斷 |
| `skills.maxSkills` | `3` | 最多選幾個 skill |
| `skills.threshold` | `0.5` | Luna 給出的 P(應載入) 達此值才選用 |
| `retrieve.allowedRoots` | `[]` | `root` 可位於的資料夾（絕對路徑）；空清單＝僅工作資料夾之下。只能來自信任的設定檔 |
| `retrieve.maxWalkMs` | `5000` | repo 走訪的時間上限（毫秒），逾時只用已索引部分 |
| `retrieve.shortlist` | `12` | 送給 Luna 判斷的候選 chunk 數 |
| `retrieve.threshold` | `0.5` | chunk 的 P(相關) 達此值才選用 |
| `retrieve.budgetTokens` | `4000` | 回傳 chunk 的 token 預算（以粗估計算） |
| `retrieve.chunkLines` | `40` | 每個 chunk 的行數 |
| `retrieve.chunkOverlap` | `10` | 相鄰 chunk 重疊行數（須小於 `chunkLines`） |
| `retrieve.maxFileBytes` | `1000000` | 超過此大小的檔案跳過 |
| `retrieve.maxFiles` | `5000` | 最多索引幾個檔案，超過則略過其餘（靜默截斷） |
| `retrieve.excerptChars` | `600` | 送給 Luna 的每個 chunk 文字截斷長度 |
| `retrieve.extensions` | 30 種常見副檔名 | 只索引這些副檔名（`.js`、`.ts`、`.py`、`.rs`、`.go`、`.md`、`.json` 等） |
| `retrieve.ignoreDirs` | `.git`、`node_modules`、`target`、`dist`、`build`、`.venv`、`venv`、`__pycache__`、`.next`、`coverage`、`.luna-test` | 不進入的資料夾名稱 |
| `memory.path` | `""`（即 `<home>/memory.jsonl`） | 記憶 JSONL 檔 |
| `memory.shortlist` | `12` | 記憶搜尋的候選數 |
| `memory.recallThreshold` | `0.5` | 記憶的 P(適用) 達此值才回傳 |
| `memory.maxRecall` | `5` | 最多回傳幾筆記憶（`limit` 缺省時） |
| `memory.durableThreshold` | `0.5` | P(durable) 低於此值即 skip |
| `memory.duplicateSimilarity` | `0.8` | Jaccard 相似度達此值，規則視為重複並更新既有記憶 |
| `compress.softRatio` | `0.6` | 用量低於此比例的視窗不壓縮，也不問 Luna |
| `compress.hardRatio` | `0.85` | 高於此比例強制壓縮；介於兩者之間由 Luna 的 `compact_now` 決定 |
| `compress.targetRatio` | `0.5` | 壓縮後用量須 ≤ 此比例，規則會逐步升級直到達到 |
| `compress.keepRecentTurns` | `2` | 最近幾個 turn 不納入壓縮 |
| `compress.maxSegmentsAsked` | `24` | 最多問 Luna 幾段（依 tokens 由大到小） |
| `compress.excerptChars` | `400` | 送給 Luna 的每段文字截斷長度 |
| `compress.summaryChars` | `400` | 摘要的最大字數（至少 64） |
| `cacheTtlMs` | `30000` | skill 目錄與 repo 索引的快取時間（毫秒）；`0`＝不快取 |
| `ledger.enabled` | `true` | 是否寫入 ledger |
| `ledger.path` | `""`（即 `<home>/decisions.jsonl`） | ledger 的 JSONL 檔 |
| `server.host` | `127.0.0.1` | HTTP sidecar 的監聽位址 |
| `server.port` | `8792` | HTTP sidecar 的埠（0 到 65535） |

`route.models` 的內建三個模型（Claude）：

| id | tier | contextWindow | efforts | 說明 |
|---|---|---|---|---|
| `claude-haiku-5-5` | 1 | 200000 | low 到 max | 快速便宜：查詢、例行編輯、工作型任務 |
| `claude-sonnet-5-5` | 2 | 200000 | low 到 max | 強的程式模型：功能、聚焦除錯、審查 |
| `claude-opus-5-5` | 3 | 200000 | low 到 max | 最深的推理：架構、隱晦的 bug、安全、長多步驟工作 |

每個模型的欄位為 `id`、`tier`（正整數）、`contextWindow`（正整數）、`capabilities`（如 `tools`、`vision`）、`local`（布林）、`efforts`（`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 的子集）與 `strengths`（會送給 Luna，請寫實際能力）。

### 環境變數

環境變數會覆蓋設定檔。

| 變數 | 對應 | 說明 |
|---|---|---|
| `LUNA_CORE_MODE` | `mode` | `auto`、`luna`、`heuristic`（轉為小寫；其他值報錯） |
| `LUNA_API_KEY` | `apiKey` | Luna 的金鑰，優先於 `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | `apiKey` | 次於 `LUNA_API_KEY` |
| `OPENAI_ORG_ID`（或 `OPENAI_ORGANIZATION`） | `organization` | 送出 `openai-organization` 標頭 |
| `OPENAI_PROJECT_ID`（或 `OPENAI_PROJECT`） | `project` | 送出 `openai-project` 標頭 |
| `LUNA_DECISION_URL` | `luna.url` | Decisions API 端點 |
| `LUNA_DECISION_MODEL` | `luna.model` | 決策模型 id |
| `LUNA_DECISION_TIMEOUT_MS` | `luna.timeoutMs` | 逾時（正整數，毫秒） |
| `LUNA_CACHE` | `luna.cacheMode` | `explicit`、`implicit`、`off` |
| `LUNA_MIN_CONFIDENCE` | `minConfidence` | 棄權門檻（0 到 1） |
| `LUNA_CORE_HOME` | 家目錄 | 預設 `~/.luna-decision-core`；記憶、ledger、`config.json` 與 env 檔的位置 |
| `LUNA_CORE_CONFIG` | 設定檔路徑 | 指定時找不到檔案會報錯 |

## 10. 費用

- **計費方式**：Decisions API 只計輸入 token。本 repo 的 client 把輸出視為免費（`src/luna/client.js`）。
- **費用數字是上限**：`decision.cost` 以未快取輸入價 USD 0.10 / 1M tokens 計算（`USD_PER_INPUT_TOKEN`）。快取讀取比較便宜，所以實際帳單通常較低。實際金額以 OpenAI 帳單為準；價格變動時請改這個常數。
- **快取**：所有呼叫共用同一段 rubric，它放在請求最前面，並標記 explicit cache breakpoint，同時帶 `prompt_cache_key`（`luna-decision-core/v1`）。命中數回報於 `decision.tokens.cached`。**快取命中率尚未在本 repo 實測。** 若 API 以含 "cache" 字樣的 400 拒絕 explicit cache，程式會改用 implicit 重試，之後不再送 explicit。
- **批次**：每次呼叫最多 `luna.maxQuestionsPerCall`（預設 16）題。超過時分成多次呼叫，依序送出，每批都重送 rubric 與 state，因此輸入 token 隨批次數成長。例如 `compress` 最多問 24 段（`maxSegmentsAsked`）再加上 `compact_now`，共最多 25 題，會分成 2 次呼叫。
- **次數與用量**：`decision.calls` 與 `engine.stats().lunaCalls` 記錄呼叫次數；`engine.stats().cost` 為各次上限的加總。
- **不呼叫 Luna 的情況**：`heuristic` 模式；`retrieve` 沒有候選；`memory_recall` 沒有候選；`memory_write` 遇到疑似秘密或與既有記憶相似度 ≥ 0.95；`compress` 用量低於 `softRatio`；以及暫停期間。

**失敗與暫停**（`src/luna/client.js`）：

| 情況 | 暫停時間 |
|---|---|
| 逾時 | 30 秒 |
| 401 或 403 | 10 分鐘 |
| 429 | 依 `Retry-After`（上限 10 分鐘）；沒有此標頭則 60 秒 |

暫停以「端點 URL + 金鑰」為單位。暫停期間，`auto` 直接退回規則，`luna` 直接失敗，不會每次都等逾時。

## 11. 紀錄與隱私

- **位置**：`<home>/decisions.jsonl`（`ledger.path` 可改），預設開啟（`ledger.enabled`）。每個 decision 一行 JSON。
- **欄位**：`ts`、`kind`、`source`、`confidence`、`cost`、`tokens`、`calls`、`latencyMs`、`error`、`summary`。
- **`summary` 內容**是各 kind 的一行摘要，例如 `claude-sonnet-5-5 effort=high`、`skills: 1 selected (rust-testing), 0 considered`、`1 of 1 chunks, 14 tokens`、`save_new (feedback)`。摘要包含模型 id、skill 名稱、記憶 id 與動作，但**不含任務、查詢、觀察內容、段落內容或記憶文字**。skill 名稱與記憶 id 仍可能透露你在做什麼，請把 ledger 當作本機的中繼資料。
- **寫入失敗**：只在 stderr 警告一次，decision 照常回傳。
- 記憶庫（`<home>/memory.jsonl`）會保存記憶文字。它會拒絕疑似秘密的內容，但不加密。

## 12. 已知限制

- **記憶庫以鎖檔協調多個程序。** 每次寫入都在 `<file>.lock`（O_EXCL）內做「讀取、修改、暫存檔 + rename」；搶不到鎖會等待最多約 2 秒後失敗，超過 10 秒的鎖視為殘留而移除。讀不懂、欄位錯誤或疑似秘密的行在下次寫入時移到 `<file>.rejected`（疑似秘密者只記行號與原因，不存原文）。
- **Skill 目錄與 repo 索引快取 `cacheTtlMs`（預設 30 秒）。** 長時間執行的 `serve`／`mcp` 在快取過期後會看到 `SKILL.md` 與原始碼的變化；設為 `0` 則每次重建。
- **檢索的 `root` 有範圍限制。** `root` 必須位於 `retrieve.allowedRoots` 之一；清單為空時，只能位於載入設定時的工作資料夾之下。`root` 若是連結（symlink、junction），其實際路徑也必須在允許範圍內。被索引的片段可能送給 Luna。
- **repo 索引遇錯略過、逾時截斷。** 無權限或消失的資料夾與檔案（EACCES、EPERM、EBUSY、ENOENT、ELOOP）會被略過；走訪超過 `retrieve.maxWalkMs` 或 `maxFiles` 時停止，只用已索引的部分。符號連結與連接點不會被追蹤。
- **front matter 解析器只支援子集。** 只認頂層的 `key: value`；值可為純文字、單引號或雙引號字串，或 `>`、`|` 區塊。其他 YAML（流程式清單、錨點、巢狀物件等）會被忽略，不會猜測。同一鍵出現多次時取第一次。缺少 `name` 時用資料夾名稱。
- **無法讀取的 SKILL.md 會讓 `skills` 決策明確失敗。** 例如權限不足，或 `SKILL.md` 是資料夾。錯誤訊息為 `loadCatalog: cannot read <path>: ...`，在所有模式下都不退回規則。資料夾中沒有 `SKILL.md` 則靜默略過，不存在的 `dirs` 項目同樣略過。
- **規則是關鍵字比對。** `HARD_TASK`、`DEEP_QUESTION` 等樣式會有漏判與誤判。
- **redaction 是樣式比對**，不是秘密偵測的保證（見第 2 節）。它偏向從嚴：程式碼中的 `password: string`、`auth = ...` 之類寫法也會被遮蔽。
- **HTTP sidecar 沒有驗證。** 保持綁定 loopback。
- **GPT 模型的 effort 與 contextWindow 尚未在本 repo 實測。** 範例設定中的值見第 9 節。

## 13. 開發

```bash
npm test          # node --test "test/**/*.test.js"; no network, no key (fakeLuna and temp folders)
```

- 測試使用 `test/helpers/fakeLuna.js` 與暫存資料夾，不連網、不使用真實金鑰。
- CI（`.github/workflows/test.yml`）：`ubuntu-latest` 與 `windows-latest`，Node `22.15` 與 `24`，執行同一條測試指令。目前沒有 lint 步驟。
- 原始碼佈局（摘錄）：

| 路徑 | 職責 |
|---|---|
| `bin/luna-core.js` | CLI（probe、各 kind 指令、serve、mcp、config） |
| `src/engine.js`、`src/registry.js`、`src/ledger.js` | 決策流程、kind 註冊、ledger |
| `src/domains/*.js` | 六個 kind 的規則、輸入輸出、gate 與 finalize |
| `src/luna/client.js`、`src/luna/answers.js` | Decisions API 傳輸、答案解析 |
| `src/config.js`、`src/defaults.js`、`src/envfile.js`、`src/contract.js` | 設定、預設值、env 檔、共用契約與 redaction |
| `src/skills/catalog.js`、`src/index/*.js`、`src/memory/store.js` | SKILL.md 掃描、repo 索引、記憶庫 |
| `docs/design.md` | 規格（權威來源） |

## 14. 授權

MIT License。Copyright (c) 2026 stevenke1981。見 [`LICENSE`](LICENSE)。
