# 決策模型的實用工作流程

本工具的 `gpt-6-luna` 負責**判斷**；`route.models` 中的模型負責外層 agent
接下來的**執行**。這兩組設定互相獨立。設定中的模型名稱代表允許考慮的候選，
不代表這個帳號已經能呼叫它，也不會替 Codex 或 Claude Code 切換模型。

## 1. 先看本機設定是否能用

在專案目錄執行：

```powershell
node .\bin\luna-core.js doctor
node .\bin\luna-core.js doctor --json
```

`doctor` 預設輸出文字，`--json` 提供結構化資料。它檢查有效設定、執行模式、
金鑰是否已設定、技能與資料路徑，以及路由候選；不呼叫 API、不寫入資料，
也不輸出金鑰原文。`auto`／`luna` 缺少金鑰時會指出問題並回傳 exit 1。
這只驗證本機準備狀態；金鑰有效性與模型使用權仍屬 `not_run`／`not_checked`。

若目前只要離線測試：

```powershell
node .\bin\luna-core.js doctor --mode heuristic
node .\bin\luna-core.js route --mode heuristic --task "重新命名變數" --format text
```

設定好金鑰後，`node .\bin\luna-core.js probe` 才會實際呼叫 Luna 並產生
API 用量。想確認模型確實參與某次決策，可使用 `--mode luna`，並檢查結果的
`source` 是否為 `luna` 或 `luna+rules`。`settled` 表示規則已能確定結果，
即使嚴格模式也不必呼叫模型。

## 2. 用 JSON 傳完整上下文

簡單任務繼續使用 `--task`。需要帶入失敗步驟、候選模型或較長中文文字時，
使用 `--input`，可避免命令列跳脫與長字串問題：

```powershell
node .\bin\luna-core.js route --input .\examples\route-input.json --mode heuristic --format text
```

同一份 JSON 也可以由程式透過 stdin 傳入：

```powershell
Get-Content -Raw -Encoding utf8 .\examples\route-input.json |
  node .\bin\luna-core.js route --input - --mode heuristic
```

```bash
node ./bin/luna-core.js route --input - --mode heuristic < examples/route-input.json
```

輸入本體是該決策的完整 JSON 物件，支援 UTF-8 BOM，上限 1 MiB。
`route`、`skills`、`retrieve`、`recall`、`remember`、`compress` 都能使用
`--input FILE|-`。相對的 `root`、`dirs` 以命令的工作目錄為基準。
未定義的頂層輸入欄位會報錯，例如記憶預覽的欄位必須是 `dryRun`，不能拼成 `dryrun`。
既有的 `compress --file` 同樣接受 UTF-8 BOM，並採用 1 MiB 檔案大小限制。

同一個指令不可同時使用 `--input` 與該指令的個別輸入旗標；例如
`route --input request.json --task ...`、`remember --input request.json --dry-run`
會直接報錯。要預覽記憶寫入，請在 JSON 裡設定 `"dryRun": true`。
`--config`、`--mode`、`--format` 仍可搭配使用。

預設 stdout 維持 JSON，方便 agents 解析；`--format text` 提供摘要、來源、
理由、錯誤與完整結果，適合人閱讀。MCP stdio 仍只輸出 JSON-RPC。

## 3. 中文任務搭配英文 skills

預設以 BM25 文字比對產生候選。任務與 skill 說明沒有共同詞時，候選可能為空。
可在信任的設定檔加入：

```json
{
  "skills": {
    "semanticFallback": true,
    "shortlist": 12
  }
}
```

當沒有文字命中、沒有明確指定的 skill，且目錄不為空時，這個選項會把目錄
前 `shortlist` 個 skill 交給 Luna 判斷。`reasons` 會寫明實際考慮了總數中的
多少個；它沒有搜尋整個大型目錄的保證。對數百個 skills，外層應先提供與工作
相關的小目錄，或在 skill 說明中加入中英文觸發語句。

附帶的範例使用中文任務與兩個英文說明：

```powershell
# 以下需要有效金鑰，會產生 API 用量。
node .\bin\luna-core.js skills --input .\examples\skills-semantic-input.json `
  --config .\examples\skills-semantic.config.json --mode luna --format text
```

`semanticFallback` 預設為 `false`。`heuristic` 模式不會執行語意判斷；模型
呼叫失敗時，`auto` 仍只依本機有證據的文字命中選擇，不會把所有候選當成相關。

## 4. 如何接到 agent

每次準備呼叫主模型前，讓外層程式組合目前任務、`contextTokens`、`steps`
與允許使用的 `candidates`，呼叫 `route`。讀取 `result.model`、`result.effort`
與 `source`，再由宿主執行模型呼叫。驗證完成後，把實際成功或失敗的步驟傳給
下一次決策。不要把「收到決策 JSON」當作「已切換或執行主模型」。

程式可以用 CLI JSON、HTTP 或 MCP；已有 Node.js harness 時，也能直接使用
`createEngine()`。各介面的資料形狀見 [整合指南](integration.md)。

## 5. 看懂失敗與用量

| 回報 | 實際意思 |
| --- | --- |
| `source: luna` | 模型答案通過格式與信心檢查後使用。 |
| `source: luna+rules` | 模型答案再經規則調整。 |
| `source: rules` 加 `error` | `auto` 發生模型錯誤或棄權，回退到本機規則；`error` 保留原因。 |
| `source: settled` | 本機已有確定答案，沒有發出決策請求。 |
| `calls` | 成功返回 body 的 transport 次數；不包含拋出錯誤的 HTTP 請求或快取協商重試。 |
| `cost` | 以基本輸入單價計算的估計值，不是實際帳單或保證上限。 |

`calls: 0` 本身不能證明沒有送出 HTTP 請求；逾時或 HTTP 錯誤也可能回報零。
要保證離線，使用 `heuristic` 或 `doctor`。費用估計未計入快取寫入、地區或
長上下文調整，實際費用以 provider 用量與帳單為準。

設定欄位拼錯、錯誤型別、無效範圍會在啟動時報錯。例如 `luna.timeotMs` 不會
被默默忽略，`route.contextHeadroom` 必須至少為 `1`，每批問題數必須在
`1..400`。既有自訂設定若使用了未定義欄位，需先移除或更正欄位名稱。

## 來源與驗證範圍

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)：
  typed answers、信心、批次與快取語意；查閱日期 2026-11-05。
- [Create a decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)：
  問題與回答格式；查閱日期 2026-11-05。
- [本次變更與驗證報告](team/v2/verification.md)：區分離線回歸、平台驗證、
  真實 API 與決策品質評估。

本次自動測試驗證資料確實送進模型介面、異常能正確阻止或回退，以及各介面的
行為；模擬回答不能證明 Luna 對真實中文任務的選擇準確率。
