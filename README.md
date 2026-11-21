# agent-quality

**檢查、維護並傳承專案的程式碼規範。** `agent-quality` 使用專案既有的 linter 與架構設定，檢查程式碼風格、程式碼慣例及模組依賴邊界。適用的測試和審查結果由品質閘門彙整，供開發代理和 CI 判斷變更是否符合專案設定的要求。

反覆出現的工程問題會列為候選。維護者核准特定版本並啟用後，插件將規範、理由及可用的正反例寫入受測專案的 `docs/agent-quality-rules.md`，由根目錄的 `AGENTS.md` 指向它，供後續開發讀取。典型規範包括「domain 層禁止依賴 adapters」和「新程式碼禁止匯入已退役的 adapter」。業務規則與產品驗收由專案的業務知識與 BDD 流程維護。

請將 Node.js 20 以上版本加入 `PATH`。本插件無 npm 依賴。

## 安裝 Codex 插件

在本儲存庫根目錄執行：

```sh
codex plugin marketplace add .
codex plugin add agent-quality@agent-quality-local
codex plugin list --marketplace agent-quality-local
```

安裝後，在 Codex 的 **Settings → Hooks** 或對話輸入區的 **Review hooks** 審閱並信任插件 Hooks，然後開啟新對話。使用 Codex 編輯工具改檔後會自動 lint，有變更的回合結束前會跑品質閘門。若可信任專案需要讓 Hook 執行設定中的測試等命令，請在其 `.agent-quality.json` 將 `qualityGate.hookCommands` 設為 `true`。專案設定可請 Codex 透過 `init` 技能建立。

重複診斷會自動列為候選。Codex 可依 `rule-learning` 技能準備提案與案例，維護者在對話中明確核准該規則版本後，由 Codex 執行啟用並更新 `docs/agent-quality-rules.md`。Shell 或外部編輯器的任意寫檔目前不會觸發這個改檔 Hook。下方 CLI 也可獨立在受測專案或 CI 執行。[OpenAI 插件文件](https://developers.openai.com/plugins/build/plugins)

## 安裝 Claude Code 插件

請使用支援命令 Hook 的 `args` 欄位的 Claude Code 版本。從受測專案目錄執行，並將範例中的路徑換成本儲存庫的絕對路徑。

```sh
claude plugin validate "/path/to/agent-quality" --strict
claude --plugin-dir "/path/to/agent-quality"
```

在 Claude Code 輸入 `/agent-quality:` 即可查看 9 個技能。可在其他專案執行同一個載入指令。若要持續使用，可加入本機 marketplace 後安裝。

```sh
claude plugin marketplace add "/path/to/agent-quality"
claude plugin install agent-quality@agent-quality-local
```

## 設定受測專案

新專案安裝插件後，請在專案根目錄叫用 `init` 技能，或直接執行：

```sh
node "/path/to/agent-quality/bin/quality.mjs" init
```

`init` 會掃描專案的工具設定並建立 `.agent-quality.json`，回報偵測到的 linter 和待確認的檢查。若專案的 `test` 指令是 `node --test`，會自動填入單元測試命令。專案已有設定檔時會回傳 `EXISTS`。請依實際工具補上型別檢查、審查和 BDD 等必要項目。

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

## 插件如何運作

1. **改完就檢查。** Claude Code 的 `PostToolUse` 在 `Write`、`Edit` 或 `MultiEdit` 完成後，使用專案現有的 linter 檢查變更檔案。內容與相關設定相同時可重用快取。發現問題時，Hook 會把規則、檔案、行號及訊息回傳給代理。
2. **修正後重驗。** 支援的工具可提供安全修正預覽，由代理檢查後套用最小修改。同一問題預設最多嘗試 3 次。驗證會確認原始診斷已消除，再執行品質閘門。
3. **結束前跑品質閘門。** 閘門依變更風險或 `.agent-quality.json` 的明確設定執行必要檢查，可包含測試、Superpowers 審查和既有 BDD 驗證。Claude Code 的 `Stop` Hook 遇到可自動處理的失敗時，最多要求代理再繼續一輪。CI 可獨立執行相同的 `gate` 指令。

## 規則如何學習與生效

插件依**診斷來源與規則 ID**歸類。同一任務的重試只算一次，預設同類問題出現在兩個不同任務後才列為候選，可用 `learning.minimumOccurrences` 調高門檻。Claude Code Hooks 使用會話 ID，從 CLI 執行時用 `--task` 標識任務。

候選出現後，代理或維護者先確認共通根因，再建立有證據的提案。**由學習機制新增的 lint 規則，必須提交人工審核，取得維護者確認後才能啟用。** 提交時附上根因、重複診斷，以及應攔截和應放行的案例。維護者可據此檢查誤報與規則衝突。專案既有的 lint 規則照常執行。已啟用的學習規則可停用或回滾，紀錄和版本放在各專案自己的 `.agent-quality/`。

內建執行器支援依副檔名比對區分大小寫的固定文字，註解與字串也可能命中。涉及語法、回歸測試或團隊指引的提案，由專案實作與審查。學習更新的是專案規則與流程，模型權重保持原樣。

### 實例：阻止兩次被匯入的退役模組

以下 PowerShell 範例使用全新的暫存專案。請在本儲存庫根目錄執行第一段，再於同一個 PowerShell 視窗繼續。它模擬兩次審查都發現 `legacy-adapter.js` 被匯入。

```powershell
$aqCli = (Resolve-Path './bin/quality.mjs').Path
$aqExample = Join-Path ([IO.Path]::GetTempPath()) ('agent-quality-demo-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $aqExample | Out-Null
Push-Location $aqExample

"import './legacy-adapter.js'" | Set-Content -Encoding ascii index.js
$aqDiagnostic = '[{"source":"review","severity":"error","file":"index.js","line":1,"rule":"legacy-import","message":"Retired adapter imported"}]'
$aqDiagnostic | node $aqCli collect --task review-101
$aqDiagnostic | node $aqCli collect --task review-102
$aqCandidate = @(node $aqCli proposals | ConvertFrom-Json)[0]
$aqCandidate.occurrences  # 2

@{
  id = 'no-legacy-adapter'
  title = 'Use the current adapter'
  type = 'lint'
  signal = $aqCandidate.signal
  rootCause = 'Two tasks copied the import from an obsolete example.'
  fix = 'Use the current adapter entry point.'
  matcher = @{ extensions = @('.js'); literal = "import './legacy-adapter.js'" }
} | ConvertTo-Json -Depth 5 -Compress | node $aqCli propose

$aqFixtures = @(
  @{ extension = '.js'; text = "import './legacy-adapter.js'"; matches = $true }
  @{ extension = '.js'; text = "import './current-adapter.js'"; matches = $false }
)
ConvertTo-Json -InputObject $aqFixtures -Compress | node $aqCli validate-rule no-legacy-adapter
```

驗證回傳 `passed: true` 後，將提案、兩次診斷和案例提交給維護者。**只有維護者實際核准後**，才執行下一段。將 `maintainer-name` 換成實際核准者。

```powershell
'{"approvedBy":"maintainer-name"}' | node $aqCli approve-rule no-legacy-adapter
node $aqCli activate-rule no-legacy-adapter
node $aqCli architecture -- index.js  # FAIL，回報 no-legacy-adapter

node $aqCli rollback-rule no-legacy-adapter
node $aqCli architecture -- index.js  # NOT_CONFIGURED，此範例沒有其他架構設定
Pop-Location
```

範例使用 `architecture` 查看內建學習規則產生的診斷。第一次啟用的前一個狀態是「尚未啟用」，因此回滾後 `activeVersion` 會是 `null`。

## 技能一覽

| 技能 | 用途 |
| --- | --- |
| `init` | 分析新專案並產生 `.agent-quality.json` |
| `lint-guard` | 使用現有 lint 工具產生結構化診斷 |
| `auto-fix` | 預覽修正、限制重試次數並驗證品質閘門 |
| `quality-review` | 將 Superpowers 的審查結果轉成標準診斷格式 |
| `rule-learning` | 追蹤重複問題，驗證規則並保留版本及核准紀錄 |
| `architecture-guard` | 檢查設定的架構邊界與循環相依 |
| `quality-gate` | 依變更風險或明確設定執行必要檢查 |
| `quality-report` | 彙整任務指標與歷史趨勢 |
| `test-selector` | 選擇受影響的測試，影響範圍不明時擴大驗證 |

延伸閱讀包括[架構與測試選擇](docs/architecture.md)、[規則學習與指標](docs/learning.md)及[整合與操作指南](docs/operations.md)。
