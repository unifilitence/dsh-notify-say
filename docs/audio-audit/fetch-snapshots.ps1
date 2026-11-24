#Requires -Version 7.0
# ADR-0015 L3: needs PowerShell 7 (Windows PowerShell 5.1 mis-reads BOM-less UTF-8: pitfalls #1/#480/#482)

# 批量抓取音色条款快照
#
# 用途：把各音色官方规约的**正文**存成本地快照，作为审核证据。
#
# 为什么必须这样做：
#   2026-10-18 我曾只依赖搜索摘要，漏掉了「波音リツ」页面顶部的
#   "VOICEVOXを使用する場合、「VOICEVOX」のクレジットが必要"，
#   差点做出错误判断。二手摘要不可靠，必须留原文。
#
# 用法：在 browser-auto 技能目录下运行
#   & $env:DSHX_NODE scripts/browser.mjs --url <url> --action text

$ErrorActionPreference = 'Continue'
# 浏览器自动化工具目录。默认取技能目录，可用环境变量覆盖。
$browser = if ($env:BROWSER_AUTO_DIR) { $env:BROWSER_AUTO_DIR } else { Join-Path $env:USERPROFILE '.codex\skills\browser-auto' }
# 快照输出到本脚本所在目录下的 snapshots/（以脚本自身为基准，不依赖绝对路径）
$outDir = Join-Path $PSScriptRoot 'snapshots'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 音色 → 官方条款 URL（我方已使用的 16 个 VOICEVOX 音色）
$targets = [ordered]@{
  # SSS / ずんずんプロジェクト（7 个配置共用一份）
  'sss-zundamon'          = 'https://zunko.jp/con_ongen_kiyaku.html'
  'sss-anonymous-common'  = 'https://zunko.jp/con_ongen_kiyaku.html'

  # 独立角色
  'ameharu-hau'           = 'https://amehau.com/rules/amehare-hau-rule.html'
  'goki-nuigurumi'        = 'https://xn--n8jychz0k1d.com/voice_terms/'
  'kasukabe-tsumugi'      = 'https://tsumugi-official.studio.site/rule'
  'manbetsu-hanamaru'     = 'https://100hanamaru.wixsite.com/manbetsu-hanamaru/rule'
  'meimei-meria'          = 'https://www.meimeihimari.com/terms-of-use'
  'mochiko'               = 'https://vtubermochio.wixsite.com/mochizora/'
  'namiine-ritsu'         = 'https://www.canon-voice.com/terms/'
  'shirakami-kotaro'      = 'https://www.virvoxproject.com/voicevoxの利用規約'
  'yurei-chan'            = 'https://u-stella.co.jp/voicevox-ure-chan-tucumo-terms-of-use/'

  # VOICEVOX 自身
  'voicevox-software'     = 'https://voicevox.hiroshiba.jp/term/'
  'voicevox-vvm-terms'    = 'https://raw.githubusercontent.com/VOICEVOX/voicevox_vvm/main/TERMS.txt'
}

Push-Location $browser
try {
  foreach ($name in $targets.Keys) {
    $url = $targets[$name]
    $outFile = Join-Path $outDir "$name.txt"
    Write-Host ("--- {0} ---" -f $name) -ForegroundColor Cyan
    Write-Host ("    {0}" -f $url) -ForegroundColor DarkGray

    try {
      $text = & $env:DSHX_NODE scripts/browser.mjs --url $url --action text --max-chars 20000 2>&1 | Out-String
      # ⚠️ 必须校验"真的是页面正文"。
      # 踩过：抓取失败时 PowerShell 把 stderr 的异常文本也当输出，
      # 于是"错误堆栈"被当成内容写进了快照文件（还以为成功了）。
      # 判定标准：有 TITLE/TEXT 标记，且不含 Node 异常特征。
      $looksLikeError = $text -match 'ERR_CONNECTION|UncaughtException|node:internal|at .*browser\.mjs:'
      $hasPageMarker = $text -match 'TITLE:'
      if ($text -and $text.Length -gt 200 -and $hasPageMarker -and -not $looksLikeError) {
        $header = "# 快照：$name`r`n# URL: $url`r`n# 抓取时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n# 工具: browser-auto (Edge + Playwright)`r`n`r`n"
        [System.IO.File]::WriteAllText($outFile, $header + $text, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host ("    OK  {0:N0} 字符" -f $text.Length) -ForegroundColor Green
      } else {
        Write-Host "    FAIL 内容过短" -ForegroundColor Red
      }
    } catch {
      Write-Host ("    FAIL {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
    Start-Sleep -Milliseconds 800
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "=== 快照结果 ===" -ForegroundColor Cyan
Get-ChildItem $outDir -File | Sort-Object Name | ForEach-Object {
  Write-Host ("  {0,-32} {1,8:N0} B" -f $_.Name, $_.Length)
}
