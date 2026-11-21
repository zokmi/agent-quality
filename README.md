# agent-quality

可跨專案使用的程式碼品質工具，提供增量 lint、回歸驗證、架構邊界檢查與專案內的規則學習。請將 Node.js 20 以上版本加入 `PATH`。本插件無 npm 依賴。

## 安裝 Codex 插件

在本儲存庫根目錄執行：

```sh
codex plugin marketplace add .
codex plugin add agent-quality@agent-quality-local
codex plugin list --marketplace agent-quality-local
```

安裝後開啟新的 Codex 對話即可使用插件。下方的命令列用法可在受測專案中獨立執行。自動 Hooks 的端對端驗證使用 Claude Code。[OpenAI 插件文件](https://developers.openai.com/plugins/build/plugins)

## 安裝 Claude Code 插件

請使用支援命令 Hook 的 `args` 欄位的 Claude Code 版本。從受測專案目錄執行，並將範例中的路徑換成本儲存庫的絕對路徑。

```sh
claude plugin validate "/path/to/agent-quality" --strict
claude --plugin-dir "/path/to/agent-quality"
```

在 Claude Code 輸入 `/agent-quality:` 即可查看 8 個技能。可在其他專案執行同一個載入指令。若要持續使用，可加入本機 marketplace 後安裝。

```sh
claude plugin marketplace add "/path/to/agent-quality"
claude plugin install agent-quality@agent-quality-local
```

## 設定受測專案

將下列範例存成專案根目錄的 `.agent-quality.json`，並依專案現有工具調整必要檢查與命令參數。

```json
{
  "lint": {"enabled": true, "incremental": true},
  "autoFix": {"enabled": true, "maxRetries": 3},
  "review": {"enabled": true, "provider": "superpowers"},
  "learning": {"enabled": true},
  "architecture": {"enabled": true},
  "qualityGate": {
    "enabled": true,
    "required": ["lint", "unit"],
    "commands": {"unit": ["node", "--test"]}
  },
  "metrics": {"enabled": true},
  "testSelection": {"enabled": true}
}
```

專案設定優先於內建預設值。各區段可設為 `enabled: false`。若停用的檢查仍列在必要項目，該項會回傳 `SKIPPED`，品質閘門也會失敗。執行紀錄保存在專案的 `.agent-quality/`，請將此目錄排除在版本控制之外。

## 命令列與 CI

從受測專案根目錄執行：

```sh
node "/path/to/agent-quality/bin/quality.mjs" lint --task example -- src/index.js
node "/path/to/agent-quality/bin/quality.mjs" gate --task example --markdown
node "/path/to/agent-quality/bin/quality.mjs" report --task example --markdown
```

CI 可執行相同的 `gate` 指令。所有必要檢查通過時回傳結束碼 0。必要檢查未設定、跳過、失敗或受阻時回傳 1。預設輸出 JSON，加入 `--markdown` 可取得 Markdown 摘要。

在 `--` 後列出變更檔案，或對 `select`、`gate` 加上 `--changed`，讀取本機 Git 工作樹的變更。若 CI 要驗證提交範圍，請傳入該範圍的變更檔案清單。執行 `lint` 或 `architecture` 時省略檔案路徑，即執行整個專案的檢查。

若要執行插件本身的測試，請在本儲存庫根目錄執行 `node --test`。

## 技能一覽

| 技能 | 用途 |
| --- | --- |
| `lint-guard` | 使用現有 lint 工具產生結構化診斷 |
| `auto-fix` | 預覽修正、限制重試次數並驗證品質閘門 |
| `quality-review` | 將 Superpowers 的審查結果轉成標準診斷格式 |
| `rule-learning` | 追蹤重複問題，驗證規則並保留版本及核准紀錄 |
| `architecture-guard` | 檢查設定的架構邊界與循環相依 |
| `quality-gate` | 依變更風險或明確設定執行必要檢查 |
| `quality-report` | 彙整任務指標與歷史趨勢 |
| `test-selector` | 選擇受影響的測試，影響範圍不明時擴大驗證 |

延伸閱讀包括[架構與測試選擇](docs/architecture.md)、[規則學習與指標](docs/learning.md)及[整合與操作指南](docs/operations.md)。
