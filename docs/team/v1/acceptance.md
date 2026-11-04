# v0.1.0 完成驗收（2026-11-05）

本次接手基準為 `39ea819`。驗收範圍是六類決策、函式庫、CLI、HTTP sidecar、MCP stdio，以及前一輪修正過的金鑰、設定信任、檢索範圍與記憶寫入邊界。

## 完成的修正

- HTTP 在執行決策前拒絕所有帶 `Origin` 的請求（403），並要求決策請求使用 `application/json`（415）。原先跨來源網頁可用 `text/plain` POST 寫入記憶；現在同一請求不會建立記憶或呼叫 Luna。
- 工作資料夾自動載入的設定不能變更 `server.host`。使用者家目錄與明確指定的設定仍可設定監聽位址。
- strict 模式只有 Luna 決策失敗回 502；本機記憶檔無法讀取等錯誤回 500。函式庫仍拋出原本的 Error 物件。
- 更新 README、設計規格、HTTP 整合說明與公開 repo 的套件連結。

## 當次證據

| 檢查 | 結果 | 範圍 |
|---|---|---|
| Node 24.20.0，Windows，完整測試 | PASS | 391 通過，0 失敗、略過或取消 |
| Node 22.15.0，Windows，完整測試 | PASS | 391 通過，0 失敗、略過或取消 |
| 安全與 HTTP 修正回歸 | PASS | 新增 4 項測試，先重現失敗，再修正；受影響的 HTTP、安全與 engine 共 109 項全過 |
| 實際 CLI 程序 | PASS | version、route、skills、retrieve、remember、recall、compress；無金鑰 probe 明確 exit 1 |
| 實際 `serve` 程序 | PASS | 臨時埠啟動、health、HTTP route；測試結束後關閉 |
| 實際 MCP stdio 程序 | PASS | initialize、tools/list 與六個 tools/call；回覆均為可解析 JSON-RPC |
| JavaScript 語法檢查 | PASS | 43 個 source、bin、test 檔案，`node --check` |
| 獨立審查 | PASS | 兩項 HIGH 與一項 MEDIUM 已重現並修正；針對變更重查後，無未解決發現 |
| Git 歷史公開前檢查 | PASS | 84 個歷史 blob；未發現非測試檔的憑證樣式候選或已追蹤的憑證檔；測試中的假金鑰保留 |
| `npm pack --dry-run --json` | PASS | 套件清單沒有 `.env`、`.env.local`、本機驗收資料或記憶檔；保留 `.env.example` |
| 新的付費 Decisions API 呼叫 | NOT_RUN | 本次環境未載入 OpenAI 金鑰；離線測試使用 fakeLuna 或 heuristic，未冒充線上證據 |
| Claude Code／Codex 宿主實際載入 MCP | NOT_RUN | stdio 程序已驗證；未變更或安裝使用者的全域 MCP 設定 |

完整測試指令：

```powershell
node --test --test-reporter=tap "test/**/*.test.js"
```

本機原始驗證輸出放在忽略追蹤的 `.luna-test/acceptance/`：`node22.tap`、`node24.tap`、`security-red.tap`、`http-red.tap`、`security-green.tap`、`process-smoke.json`、`syntax.json`、`history-scan.json`、`package.json`。這些輸出是本機證據，公開 repo 保留本份摘要與可重跑的回歸測試。

GitHub Actions 的 Windows／Ubuntu × Node 22.15／24 四組矩陣另見 [test workflow](../../../.github/workflows/test.yml) 與 [執行紀錄](https://github.com/stevenke1981/luna-decision-core/actions)。本機 PASS 不代表 GitHub CI 已執行。

## 證據界線

原開發對話記錄過六類決策的真實 Luna 呼叫；本次沒有重做，以上 PASS 只依本次實際觀察的結果。原本中斷的 Sonnet 第二輪驗收由本次獨立 code-reviewer 補完，沒有宣稱本次使用 Sonnet。

規則模式與假 Luna 測試不證明模型建議的品質、節省費用或真實任務完成率。模型的 context window、effort 支援與外部 harness 設定仍保留 README 中的實測限制。HTTP 仍是無認證的本機服務；瀏覽器請求防護不等同於網路身分驗證。
