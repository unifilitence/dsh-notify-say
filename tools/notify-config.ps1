#Requires -Version 5.1
# 最低 PowerShell 5.1 —— 本文件随 npm 包发给用户、README 教用户直接运行，Windows 出厂只有 5.1。
# 它带 UTF-8 BOM 且不含 PS7 独有语法（ADR-0015 L3 担心的「5.1 误读无 BOM 中文」不成立），
# 5.1 下 JSON 往返实测无损（20/20 键含中文）。不要改成 7.0 —— 见踩坑 #495。

<#
.SYNOPSIS
  dsh-notify-say 配置命令行（v0.4.0 的「第 4 层」运行时覆盖）。

.DESCRIPTION
  ## 为什么有它

  v0.4.0 起设置页 GUI 由官方 Config schema 自动生成（改 `storages` 用户层）。
  但有两类场景 GUI 不方便：

    1. 远程办公/听不见声音，只想一条命令静音；
    2. 不想为改一个音量去重启宿主。

  本脚本读写 `$DSH_HOME\storages\dsh-notify-say\config.json`
  （**本插件唯一拥有的持久文件**，不碰 cordis.patch.yml、不碰凭据、不碰别的插件）。
  插件每次播报前会重读它，故**改完立即生效，无需重启**。

  ## 优先级提醒

  生效值 = schema 默认 → cordis.patch.yml → **设置页** → **本文件**
  也就是说本文件优先级最高；改过之后设置页里同一项会被覆盖。
  想交还给设置页：用 `-Clear`。

  ## 安全设计

  - 写入前做白名单校验（未知键丢弃），不会污染文件；
  - 文件损坏时**拒绝覆盖**并提示，保留原文件供人工救；
  - 原子写（先 .tmp 后 rename），不留半截文件；
  - 只写本插件自己的目录。

.PARAMETER Show
  显示当前生效配置（合并了 patch / 设置页 / 本文件的最终值）与来源。

.PARAMETER Voice
  语音开关：on / off。

.PARAMETER Volume
  音量 0-100。

.PARAMETER VoiceMode
  音色模式：fixed（固定） / random（每次随机）。

.PARAMETER VoiceName
  固定音色 key（如 zundamon-normal）。可用 -ListVoices 查看有哪些。

.PARAMETER Enable
  打开某类提醒。可多值，逗号或空格分隔：
  complete, error, blocked, aborted, approval, question, subagents, idleGate

.PARAMETER Disable
  关闭某类提醒，取值同上。

.PARAMETER Clear
  删除本插件的 config.json，把控制权交还「设置页 / cordis.patch.yml」。

.PARAMETER ListVoices
  列出语句池里可用的音色 key 及各池覆盖情况。

.PARAMETER DryRun
  只显示将要写入什么，不落盘。

.EXAMPLE
  .\notify-config.ps1 -Show

.EXAMPLE
  # 远程办公，先静音（Toast 仍会弹）
  .\notify-config.ps1 -Voice off

.EXAMPLE
  # 音量调到 40，音色改成随机
  .\notify-config.ps1 -Volume 40 -VoiceMode random

.EXAMPLE
  # 关掉「中止」类提醒，打开子代理提醒
  .\notify-config.ps1 -Disable aborted -Enable subagents

.EXAMPLE
  # 交还控制权（回到设置页/patch 的值）
  .\notify-config.ps1 -Clear
#>
[CmdletBinding(DefaultParameterSetName = 'Set')]
param(
  [switch]$Show,
  [ValidateSet('on', 'off')]
  [string]$Voice,
  [ValidateRange(0, 100)]
  [int]$Volume,
  [ValidateSet('fixed', 'random')]
  [string]$VoiceMode,
  [string]$VoiceName,
  [string[]]$Enable,
  [string[]]$Disable,
  [switch]$Clear,
  [switch]$ListVoices,
  # ── 语音包管理（按需下载）────────────────────────────────────────────────
  # 完整语音包约 53 MB；核心包只带 2 个音色（1 日语 + 1 中文）。没装语音包时自动回退系统提示音。
  [switch]$ListPacks,
  [string]$PurgeVoice,
  [switch]$InstallHint,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ── 路径解析 ────────────────────────────────────────────────────────────────
# 本脚本位于 <plugin>/tools/，插件根 = 上一级。
# ⚠️ 不能用 $MyInvocation.MyCommand.Path —— 经 `pwsh -File` 启动时它可能为空，
# 导致 $pluginRoot 变成 $null、进而 Join-Path 拼出错误路径（实测踩到）。
# 用 $PSScriptRoot（-File 与点源两种方式都可靠）+ $MyInvocation.MyCommand.Definition 兜底。
$scriptPath = $PSScriptRoot
if (-not $scriptPath) {
  $scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
if (-not $scriptPath) {
  Write-Host "  无法确定脚本所在目录，退出。" -ForegroundColor Red
  exit 1
}
$pluginRoot = Split-Path -Parent $scriptPath
$notifyPs1 = Join-Path $pluginRoot 'dsh-notify.ps1'

function Get-DshHome {
  # 与 lib/dsh-home.js 同口径：$DSH_HOME（空白视为未设置）→ ~/.dsh。
  # ⚠️ 这里**不得**硬编码任何安装路径。曾写死过 'D:\Program Files (x86)\DSH'，
  # 那是某台开发机的安装位置；换到用户机器上会指向不存在的目录，
  # 脚本于是静默读写错误位置 —— 比直接报错更难排查。
  #
  # 失败时返回空串（与 JS 侧 resolveDshHome 一致），由调用方给出明确错误，
  # 而不是在这里抛 ParameterBindingValidationException —— 那种栈对用户毫无用处。
  $h = $env:DSH_HOME
  if ($h) { $h = $h.Trim() }
  if (-not $h) {
    # $HOME 可能为空（极简环境 / 被清过的会话）；Join-Path 传空值会直接抛异常
    $homeDir = $HOME
    if (-not $homeDir) { $homeDir = $env:USERPROFILE }
    if (-not $homeDir) { return '' }
    try { $h = Join-Path $homeDir '.dsh' } catch { return '' }
  }
  if (-not $h) { return '' }
  # 只裁**多余**的尾部斜杠：'/' 或 '\' 本身就是根，裁成空串会让后面拼出相对路径。
  $trimmed = $h.TrimEnd('\', '/')
  if (-not $trimmed) { return $h }   # 原来是纯根路径，原样返回
  return $trimmed
}

$dshHome = Get-DshHome
if (-not $dshHome) {
  Write-Error '无法解析 DSH home（$DSH_HOME 与 ~/.dsh 均不可用），无法定位配置文件。'
  exit 1
}
$configDir = Join-Path $dshHome 'storages\dsh-notify-say'
$configPath = Join-Path $configDir 'config.json'

# ── 提醒类别 → 配置键映射 ───────────────────────────────────────────────────
$KindMap = [ordered]@{
  complete  = 'notifyOnComplete'
  error     = 'notifyOnError'
  blocked   = 'notifyOnBlocked'
  aborted   = 'notifyOnAborted'
  approval  = 'notifyOnApproval'
  question  = 'notifyOnQuestion'
  subagents = 'subagents'
  idlegate  = 'idleGate'
}

$KindDesc = @{
  notifyOnComplete = '回合正常完成'
  notifyOnError    = '回合出错（失败语音）'
  notifyOnBlocked  = '回合被拦截（蜂鸣）'
  notifyOnAborted  = '中止/超长/中断'
  notifyOnApproval = '待你批准'
  notifyOnQuestion = '向你提问'
  subagents        = '子代理会话也提醒'
  idleGate         = '空闲门（有在飞工作先不播完成）'
}

# ── 读现有配置（损坏则拒绝写，保留原文件）───────────────────────────────────
function Read-ConfigDoc {
  if (-not (Test-Path -LiteralPath $configPath)) {
    return @{ ok = $true; values = @{}; exists = $false }
  }
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
  } catch {
    return @{ ok = $false; reason = "读取失败: $($_.Exception.Message)"; values = @{}; exists = $true }
  }
  if (-not $raw -or -not $raw.Trim()) { return @{ ok = $true; values = @{}; exists = $true } }
  try {
    $doc = $raw | ConvertFrom-Json
  } catch {
    return @{ ok = $false; reason = '文件不是合法 JSON'; values = @{}; exists = $true }
  }
  if ($null -eq $doc -or $doc.version -ne 1) {
    return @{ ok = $false; reason = "版本不匹配（期望 1，实际 $($doc.version)）"; values = @{}; exists = $true }
  }
  $vals = @{}
  if ($doc.values) {
    foreach ($p in $doc.values.PSObject.Properties) { $vals[$p.Name] = $p.Value }
  }
  return @{ ok = $true; values = $vals; exists = $true }
}

function Write-ConfigDoc([hashtable]$values) {
  if ($DryRun) {
    Write-Host "  [DryRun] 将写入 $configPath :" -ForegroundColor Yellow
    $values.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ("    {0} = {1}" -f $_.Key, $_.Value) }
    return $true
  }
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $doc = [ordered]@{ version = 1; values = [ordered]@{} }
  foreach ($k in ($values.Keys | Sort-Object)) { $doc.values[$k] = $values[$k] }
  $json = $doc | ConvertTo-Json -Depth 6
  $tmp = "$configPath.tmp"
  try {
    [System.IO.File]::WriteAllText($tmp, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $configPath -Force
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    Write-Host "  写入失败: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
  return $true
}

# ── -Show：显示生效值与来源 ─────────────────────────────────────────────────
function Show-Effective {
  Write-Host "=== dsh-notify-say 配置 ===" -ForegroundColor Cyan
  Write-Host ("  DSH_HOME   : {0}" -f $dshHome)
  Write-Host ("  CLI 覆盖层 : {0}" -f $configPath)

  $cur = Read-ConfigDoc
  if (-not $cur.ok) {
    Write-Host ("  ⚠️ 覆盖层损坏：{0}" -f $cur.reason) -ForegroundColor Yellow
    Write-Host "     插件会忽略它并回退到上层配置；删掉该文件即可恢复。" -ForegroundColor Yellow
  } elseif (-not $cur.exists) {
    Write-Host "     状态: 不存在（全部走 设置页 / cordis.patch.yml）" -ForegroundColor DarkGray
  } else {
    Write-Host ("     状态: 有 {0} 项覆盖" -f $cur.values.Count) -ForegroundColor DarkGray
  }

  Write-Host ""
  Write-Host "--- 覆盖层里的值（本文件优先级最高）---" -ForegroundColor Cyan
  if ($cur.ok -and $cur.values.Count -gt 0) {
    $cur.values.GetEnumerator() | Sort-Object Name | ForEach-Object {
      $desc = if ($KindDesc.ContainsKey($_.Key)) { $KindDesc[$_.Key] } else { '' }
      Write-Host ("  {0,-20} = {1,-8} {2}" -f $_.Key, $_.Value, $desc)
    }
  } else {
    Write-Host "  （无）" -ForegroundColor DarkGray
  }

  # 从 patch 读基线（只读，不解释优先级，仅供对照）
  $patch = Join-Path $pluginRoot 'cordis.patch.yml'
  if (Test-Path -LiteralPath $patch) {
    Write-Host ""
    Write-Host "--- cordis.patch.yml 里的基线（会被上面覆盖）---" -ForegroundColor Cyan
    Get-Content -LiteralPath $patch -Encoding UTF8 |
      Where-Object { $_ -match '^\s+\w+:' } |
      ForEach-Object { Write-Host ("  " + $_.Trim()) }
  }
  Write-Host ""
  Write-Host "提示：设置页的值介于两者之间，此处无法直接读取（需宿主接口）。" -ForegroundColor DarkGray
}

# ── -ListVoices：列音色及各池覆盖 ───────────────────────────────────────────
function Show-Voices {
  $vl = Join-Path $pluginRoot 'sounds\voice-lines'
  if (-not (Test-Path -LiteralPath $vl)) { Write-Host "  找不到语句池目录" -ForegroundColor Red; return }

  # done 池根目录的音色 key（去掉 ~N 变体）
  $doneKeys = @(Get-ChildItem -LiteralPath $vl -File -Filter '*.wav' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.BaseName -replace '~\d+$', '' } | Sort-Object -Unique)
  foreach ($pool in @('question', 'approval', 'fail')) {
    $d = Join-Path $vl $pool
    if (Test-Path -LiteralPath $d) {
      Set-Variable -Name "keys_$pool" -Value @(Get-ChildItem -LiteralPath $d -File -Filter '*.wav' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.BaseName -replace '~\d+$', '' } | Sort-Object -Unique)
    }
  }

  Write-Host "=== 可用音色（共 $($doneKeys.Count) 个 key）===" -ForegroundColor Cyan
  Write-Host "  标记含义：完成=有完成语音  提问/审批/失败=对应池是否覆盖" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host ("  {0,-26} {1,-6} {2,-6} {3,-6} {4}" -f '音色 key', '完成', '提问', '审批', '失败')
  Write-Host ("  " + ("-" * 62))
  foreach ($k in $doneKeys) {
    $q = if ((Get-Variable -Name 'keys_question' -ValueOnly -ErrorAction SilentlyContinue) -contains $k) { '✓' } else { '-' }
    $a = if ((Get-Variable -Name 'keys_approval' -ValueOnly -ErrorAction SilentlyContinue) -contains $k) { '✓' } else { '-' }
    $f = if ((Get-Variable -Name 'keys_fail' -ValueOnly -ErrorAction SilentlyContinue) -contains $k) { '✓' } else { '-' }
    $warn = if ($f -eq '-') { '  ← 失败时无此音色台词' } else { '' }
    Write-Host ("  {0,-26} {1,-6} {2,-6} {3,-6} {4}{5}" -f $k, '✓', $q, $a, $f, $warn)
  }
  Write-Host ""
  Write-Host "说明：某池未覆盖该音色时，v0.3.1+ 会在**同池内换一个音色**（不会哑掉，也不会越池播错语义）。" -ForegroundColor DarkGray
}

# ── 语音包管理：列出本地已装包 ──────────────────────────────────────────────
function Show-Packs {
  $vl = Join-Path $pluginRoot 'sounds\voice-lines'
  Write-Host "=== 已装语音包 ===" -ForegroundColor Cyan

  if (-not (Test-Path -LiteralPath $vl)) {
    Write-Host "  没有任何语音包。" -ForegroundColor DarkGray
    Write-Host "  → 通知会使用系统提示音 + Toast（这是正常状态，不是错误）。" -ForegroundColor DarkGray
    Write-Host "  → 用 -ListVoices 查看目录里有哪些音色 key 可选；用 -PurgeVoice <key> 删除。" -ForegroundColor DarkGray
    return
  }

  # 按音色 key 汇总（去 ~N 变体）
  $acc = @{}
  foreach ($pool in @('', 'question', 'approval', 'fail')) {
    $d = if ($pool) { Join-Path $vl $pool } else { $vl }
    if (-not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -File -Filter '*.wav' -ErrorAction SilentlyContinue | ForEach-Object {
      $k = $_.BaseName -replace '~\d+$', ''
      if (-not $acc.ContainsKey($k)) { $acc[$k] = @{ pools = @(); bytes = 0; files = 0 } }
      $pname = if ($pool) { $pool } else { 'done' }
      if ($acc[$k].pools -notcontains $pname) { $acc[$k].pools += $pname }
      $acc[$k].bytes += $_.Length
      $acc[$k].files++
    }
  }

  if ($acc.Count -eq 0) {
    Write-Host "  目录存在但没有 wav 文件。" -ForegroundColor DarkGray
    return
  }

  $totalMB = 0
  Write-Host ("  {0,-26} {1,-34} {2}" -f '音色 key', '覆盖的语句类', '体积')
  Write-Host ("  " + ("-" * 74))
  foreach ($k in ($acc.Keys | Sort-Object)) {
    $v = $acc[$k]
    $mb = [math]::Round($v.bytes / 1MB, 2)
    $totalMB += $mb
    Write-Host ("  {0,-26} {1,-34} {2,7:N2} MB" -f $k, ($v.pools -join ','), $mb)
  }
  Write-Host ("  " + ("-" * 74))
  Write-Host ("  合计 {0} 个音色 / {1:N2} MB" -f $acc.Count, $totalMB) -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  说明：只装了 done 的音色，在失败时会**在同池内换音色**或回落提示音（不会播错语义）。" -ForegroundColor DarkGray
  Write-Host "  完整语音包约 53 MB；核心包自带 2 个音色（1 日语 + 1 中文）。删掉不用的用 -PurgeVoice <key>。" -ForegroundColor DarkGray
}

# ── 语音包管理：删除某音色 ──────────────────────────────────────────────────
function Remove-VoicePack([string]$key) {
  if (-not $key) { Write-Host "  需要 -PurgeVoice <音色key>" -ForegroundColor Red; return }
  if ($key -notmatch '^\w[\w-]*$') {
    Write-Host "  非法音色 key：$key" -ForegroundColor Red; return
  }
  $vl = Join-Path $pluginRoot 'sounds\voice-lines'
  $targets = @()
  foreach ($pool in @('', 'question', 'approval', 'fail')) {
    $d = if ($pool) { Join-Path $vl $pool } else { $vl }
    if (-not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -File -Filter '*.wav' -ErrorAction SilentlyContinue | Where-Object {
      ($_.BaseName -replace '~\d+$', '') -eq $key
    } | ForEach-Object { $targets += $_ }
  }
  if ($targets.Count -eq 0) {
    Write-Host "  未找到音色 '$key' 的任何 wav。" -ForegroundColor Yellow
    return
  }
  $mb = [math]::Round(($targets | Measure-Object Length -Sum).Sum / 1MB, 2)
  Write-Host ("  将删除 {0} 个文件 / {1:N2} MB（音色 {2}）" -f $targets.Count, $mb, $key) -ForegroundColor Yellow
  if ($DryRun) { Write-Host "  [DryRun] 未删除" -ForegroundColor Yellow; return }
  $n = 0
  foreach ($t in $targets) {
    try { Remove-Item -LiteralPath $t.FullName -Force; $n++ } catch { }
  }
  Write-Host ("  已删除 {0} 个文件。" -f $n) -ForegroundColor Green
  if (-not (Test-Path -LiteralPath $vl) -or @(Get-ChildItem -LiteralPath $vl -Recurse -File -Filter '*.wav' -ErrorAction SilentlyContinue).Count -eq 0) {
    Write-Host "  已无任何语音包 → 通知将使用系统提示音 + Toast（正常状态）。" -ForegroundColor DarkGray
  }
}

# ── 语音包管理：说明如何获取更多 ────────────────────────────────────────────
function Show-InstallHint {
  Write-Host "=== 如何获得更多语音 ===" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  核心包自带 2 个音色：ずんだもん（日语）+ 温柔女声（中文），约 4 MB。"
  Write-Host "  另有 15 个音色（12 日语 + 3 中文）按需下载，合计约 49 MB，故不随包发布。"
  Write-Host ""
  Write-Host "  A) 在设置页里下载（推荐）" -ForegroundColor Green
  Write-Host "     打开 DSH 设置 → 通知 → 语音包 → 选音色 → 点「下载」。"
  Write-Host "     下载完先校验 SHA-256，与 packs.json 登记的不一致会直接丢弃。"
  Write-Host ""
  Write-Host "  B) 自己合成（想用清单外的音色时）" -ForegroundColor Green
  Write-Host "     1. 安装 VOICEVOX（本地免费 TTS 引擎，约 1 GB）"
  Write-Host "     2. 启动引擎（默认 http://127.0.0.1:50021）"
  Write-Host "     3. 本次不提供现成合成脚本；手动在 VOICEVOX 里合成，把 wav 放进下面的 C) 目录"
  Write-Host ""
  Write-Host "  C) 从他人镜像下载（如提供）" -ForegroundColor Green
  Write-Host "     把 wav 放进 <插件根>\sounds\voice-lines\ 及子目录："
  Write-Host "       done     -> sounds\voice-lines\<key>~N.wav"
  Write-Host "       question -> sounds\voice-lines\question\<key>~N.wav"
  Write-Host "       approval -> sounds\voice-lines\approval\<key>~N.wav"
  Write-Host "       fail     -> sounds\voice-lines\fail\<key>~N.wav"
  Write-Host ""
  Write-Host "  D) 不装任何语音包（也是完全可用的配置）" -ForegroundColor Green
  Write-Host "     通知 = Windows Toast + 系统提示音。用 -Voice off 可只留 Toast。" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  装好后用 -ListPacks 查看，用 -VoiceName <key> 选定音色。" -ForegroundColor Gray
}

# ── 主逻辑 ──────────────────────────────────────────────────────────────────
if ($Show) { Show-Effective; return }
if ($ListVoices) { Show-Voices; return }
if ($ListPacks) { Show-Packs; return }
if ($InstallHint) { Show-InstallHint; return }
if ($PSBoundParameters.ContainsKey('PurgeVoice')) { Remove-VoicePack $PurgeVoice; return }

if ($Clear) {
  if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Host "  覆盖层本来就不存在，无需清理。" -ForegroundColor DarkGray
    return
  }
  if ($DryRun) { Write-Host "  [DryRun] 将删除 $configPath" -ForegroundColor Yellow; return }
  Remove-Item -LiteralPath $configPath -Force
  Write-Host "  已删除覆盖层：$configPath" -ForegroundColor Green
  Write-Host "  控制权已交还「设置页 / cordis.patch.yml」。" -ForegroundColor Green
  return
}

# 组装变更
$cur = Read-ConfigDoc
if (-not $cur.ok) {
  Write-Host "  拒绝写入：配置覆盖层已损坏（$($cur.reason)）" -ForegroundColor Red
  Write-Host "  原文件保留在：$configPath" -ForegroundColor Red
  Write-Host "  请先修复或删除它，再重试。" -ForegroundColor Red
  exit 1
}

$vals = @{}
foreach ($k in $cur.values.Keys) { $vals[$k] = $cur.values[$k] }
$changed = @{}

if ($PSBoundParameters.ContainsKey('Voice')) {
  $v = ($Voice -eq 'on')
  $vals['voice'] = $v; $changed['voice'] = $v
}
if ($PSBoundParameters.ContainsKey('Volume')) {
  $vals['volume'] = $Volume; $changed['volume'] = $Volume
}
if ($PSBoundParameters.ContainsKey('VoiceMode')) {
  $vals['voiceMode'] = $VoiceMode; $changed['voiceMode'] = $VoiceMode
}
if ($PSBoundParameters.ContainsKey('VoiceName')) {
  if ($VoiceName -notmatch '^\w[\w-]*$') {
    Write-Host "  非法音色 key：$VoiceName（只允许字母数字下划线连字符）" -ForegroundColor Red
    exit 1
  }
  $vals['voiceName'] = $VoiceName; $changed['voiceName'] = $VoiceName
}
foreach ($e in @($Enable)) {
  if (-not $e) { continue }
  foreach ($one in ($e -split '[,\s]+' | Where-Object { $_ })) {
    $key = $KindMap[$one.ToLower()]
    if (-not $key) {
      Write-Host "  未知类别：$one（可用：$($KindMap.Keys -join ', ')）" -ForegroundColor Red
      exit 1
    }
    $vals[$key] = $true; $changed[$key] = $true
  }
}
foreach ($d in @($Disable)) {
  if (-not $d) { continue }
  foreach ($one in ($d -split '[,\s]+' | Where-Object { $_ })) {
    $key = $KindMap[$one.ToLower()]
    if (-not $key) {
      Write-Host "  未知类别：$one（可用：$($KindMap.Keys -join ', ')）" -ForegroundColor Red
      exit 1
    }
    $vals[$key] = $false; $changed[$key] = $false
  }
}

if ($changed.Count -eq 0) {
  Write-Host "  没有指定任何变更。用 -Show 查看当前值，或 -? 看用法。" -ForegroundColor Yellow
  return
}

Write-Host "=== 将要变更 ===" -ForegroundColor Cyan
$changed.GetEnumerator() | Sort-Object Name | ForEach-Object {
  $old = if ($cur.values.ContainsKey($_.Key)) { $cur.values[$_.Key] } else { '(未设)' }
  $desc = if ($KindDesc.ContainsKey($_.Key)) { $KindDesc[$_.Key] } else { '' }
  Write-Host ("  {0,-20} {1} -> {2}  {3}" -f $_.Key, $old, $_.Value, $desc)
}

if (-not (Write-ConfigDoc $vals)) { exit 1 }

if (-not $DryRun) {
  Write-Host ""
  Write-Host "  ✓ 已保存。插件下次播报即生效，**无需重启**。" -ForegroundColor Green
  if ($changed.ContainsKey('voice') -and $changed['voice'] -eq $false) {
    Write-Host "    语音已关闭；Toast 仍会弹出。" -ForegroundColor DarkGray
  }
}
