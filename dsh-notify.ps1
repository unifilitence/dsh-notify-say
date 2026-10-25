<#
.SYNOPSIS
  dsh-notify-say 自带提醒脚本：弹 Windows Toast（+ 可选语音），由 host 插件 spawn 调起。
  裁剪自旧 tools\dsh-notify.ps1（dsh-notify-done@1.1.0），适配官方 Desktop 0.1.7-rc.2。

.DESCRIPTION
  - Toast 整块点击走官方协议 dsh://open（官方仅承诺唤起窗口，无会话级参数，见 CARD.md）；
    2026-09-25 移除「打开 DSH」按钮——整块可点后按钮冗余（用户决定）。
  - 语句池：sounds\voice-lines\*.wav（done）；question\、approval\、fail\ 子池按 -Kind 选用；
    chime = 不播语句，只走系统蜂鸣兜底（blocked / 兜底路径）。
    ⚠️ fail 池**缺失时不回落到 done 池**：那会在失败时播"任务完成了"，语义完全相反（见下方注释）。
  - 音量：-Volume 0-100（MCI setaudio）；-1 跟随系统。
  - 兜底链：语句池 → master-voice.wav → sounds\*.wav 随机 → 系统蜂鸣（双轮三连音 + Asterisk）。
    fail/chime 例外：不进 done 池与不播 master-voice，直接到系统蜂鸣（避免播成"完成"）。
  - 无外部配置文件/静默文件：开关全部由插件 config（cordis.patch.yml 行内）经参数传入。
  - 日志：best-effort 写 %TEMP%\dsh-notify-say\notify.log，失败不影响弹通知。

.PARAMETER Title   通知标题（默认 "DSH 任务提醒"）
.PARAMETER Body    通知正文（默认 "任务可能已完成，回来看看？"）
.PARAMETER NoSound 静音（只弹通知不播音）
.PARAMETER Preview 试听模式：只播放语句，不弹 Toast（人工验证用）
.PARAMETER SoundOnly 只播声音不弹 Toast（视觉通道另有消费方时用；v1 host 不用）
.PARAMETER Voice   音色 key（sounds\voice-lines\<key>.wav，含 ~ 变体与 -kansai/-extra 后缀）
.PARAMETER Mode    fixed（用 -Voice）| random（从语句池随机）
.PARAMETER Kind    done | question | approval | fail | chime（决定语句池；chime 只蜂鸣）
.EXAMPLE
  powershell -NoProfile -File dsh-notify.ps1 -Kind done -Title "DSH 任务完成" -Body "回来看看" -Voice zundamon-normal -Volume 80
.EXAMPLE
  powershell -NoProfile -File dsh-notify.ps1 -Kind fail -Title "DSH 回合出错" -Body "出问题了" -Voice zundamon-normal -Volume 80
#>
param(
  [string]$Title = "DSH 任务提醒",
  [string]$Body = "任务可能已完成，回来看看？",
  # v0.4.62：Toast 第三行（弱化的补充信息，例如项目名）。
  # 空 = 不显示第三行（模板保持两行）。由 Node 侧决定要不要传 ——
  # 只在"标题里没包含这个信息"时才传，避免重复占版面。
  [string]$Detail = "",
  [switch]$NoSound,
  [switch]$Preview,
  [switch]$SoundOnly,
  [string]$Voice = '',
  [ValidateSet('fixed', 'random')]
  [string]$Mode = '',
  # v0.5.3：语音包语言（ja / zh）。决定「随机」时抽哪个语言的台词池。
  #
  # 为什么需要：池子是中日混放的（done 池 115 个里日语 103、中文 12），
  # 从前 random 就是整个目录随便抓一个 → 大约每 10 次提醒蹦一句中文，
  # 用户听同一件事的提醒语言却来回跳。有了这个参数，随机只在同语言内抽。
  #
  # 空 = 不限制（向后兼容：老调用方不传时行为与从前一致）。
  [ValidateSet('', 'ja', 'zh')]
  [string]$Lang = '',
  [ValidateSet('done', 'question', 'approval', 'fail', 'chime')]
  [string]$Kind = 'done',
  [int]$Volume = -1,
  # v0.4.2：指定用哪个系统提示音（SystemSounds 的属性名）。
  # 传空表示不强制，走默认链（语句池 → master → sounds → 蜂鸣）。
  # 传 'auto' 表示按 -Kind 自动映射语义（失败用警告音、提问用询问音等）。
  [string]$SystemSound = '',
  # v0.4.4：直接播放用户指定的音频文件（绝对路径）。
  # 有这个参数时**跳过整个选音链**——用户明确要放这个文件，不该被兜底逻辑换掉。
  [string]$CustomFile = '',
  # v0.4.29：语音包根目录（分号/逗号分隔，前面的优先）。
  # 不传 = 只用插件目录（向后兼容）。Node 侧会传「用户目录;插件目录」。
  [string]$VoiceRoot = '',
  # 用户语音包根目录（可写），仅用于诊断日志。
  [string]$UserVoiceRoot = '',
  # v0.4.34：日志级别。info（默认）= 只记元数据；debug = 记标题与正文。
  #
  # 为什么需要：日志会写进 %TEMP%，用户提 Issue 时经常直接上传。
  # 标题与正文可能含项目名、人名，对诊断「为什么不响」却没帮助。
  [ValidateSet('info', 'debug')]
  [string]$LogLevel = 'info',
  # v0.4.70：会话 id。传了它且插件已完成协议注册时，Toast 的 launch 会写成
  #   dshnotify-say://jump?session=<id>
  # 这样点 Toast 能**精确**跳到对应会话（多会话时不会跳错）。
  # 不传（或插件协议没注册成功）时仍用 dsh://open，行为与以前一致。
  #
  # ⚠️ 2026-10-20 踩坑：这个参数曾被插到 `[ValidateSet('info','debug')]` 与
  # `[string]$LogLevel` 之间，于是 ValidateSet 套在了 SessionId 上 ——
  # 任何带 -SessionId 的调用都报「xxx 不属于 ValidateSet 集合 info,debug」，
  # exit=1、播报彻底失败（只听到 fallback 的蜂鸣）。
  # **新参数一律加在 param 块最末尾，不要插在两个相关参数中间。**
  [string]$SessionId = '',
  # v0.4.16：数字增益倍数（1.0 = 原样；2.0 = 放大一倍）。
  #
  # 为什么需要：实测本包 247 个语音包峰值中位仅 **40.4%**
  # （最小 24.7%、最大 84.4%），素材本身录得偏轻。
  # 而 MCI 的 `setaudio volume to 1000` 上限只等于原始幅度 1.0 倍、
  # **无法超过**，所以 GUI 音量拉满也还是偏小。只能靠数字增益补。
  #
  # 实际系数会按峰值自动限幅（见 lib/wav-gain.ps1），
  # 保证最响的文件也不削波。
  #
  # 只对 16-bit PCM wav 生效；mp3/m4a/flac/ogg 原样播放。
  [ValidateRange(1.0, 4.0)]
  [double]$Gain = 1.0
)

$ErrorActionPreference = 'Continue'
$shown = $false
$script:lastSound = ''
$script:playFile = ''

$SoundDir = Join-Path $PSScriptRoot 'sounds'
# ── 语音包根目录（v0.4.29：多候选，前面的优先）─────────────────
#
# 旧实现硬编码 <插件根>\sounds\voice-lines。但下载的音色必须放用户目录
# （插件目录不可写、且 npm 更新会覆盖），所以由 Node 侧算好候选路径传进来。
$script:voiceRoots = @()
if ($VoiceRoot) {
  foreach ($p in ($VoiceRoot -split '[;,]')) {
    $t = $p.Trim()
    if ($t) { $script:voiceRoots += $t }
  }
}
if ($script:voiceRoots.Count -eq 0) {
  $script:voiceRoots = @(Join-Path $SoundDir 'voice-lines')
}
# $voiceDir 保留为“主语音目录”（第一个候选），供日志与旧单目录兜底使用
$voiceDir = $script:voiceRoots[0]

# 数字增益工具（v0.4.16）。找不到就跳过增益，绝不影响播放。
$gainLib = Join-Path $PSScriptRoot 'lib\wav-gain.ps1'
if (Test-Path -LiteralPath $gainLib) {
  try { . $gainLib } catch { Write-Host ('[dsh-notify-say] 加载增益模块失败: ' + $_.Exception.Message) -ForegroundColor Yellow }
}

# ── 音量：-Volume 0-100 → MCI setaudio（volume*10）；越界/-1 跟随系统 ──────────
$script:notifyVol = $null
if ($Volume -ge 0 -and $Volume -le 100) { $script:notifyVol = [int]$Volume }

# ── 系统提示音（v0.4.2）─────────────────────────────────────────────────────
# 空的 $SystemSound = 不强制（走原有的语句池→蜂鸣链）。
# 'auto' = 按 -Kind 选语义最合适的那个：
#   失败/拦截 → 警告感（Hand / Exclamation）
#   提问/审批 → 询问感（Question）
#   完成     → 轻快（Asterisk）
# 这样"失败"和"完成"听起来不一样，不会被误判。
#
# ⚠️⚠️ 内部变量必须与参数 `$SystemSound` **明显不同名**（这里用 sysToneName）。
# 原因：PowerShell 变量名**不区分大小写**，`$script:systemSound` 与参数
# `$SystemSound` 是**同一个变量**；而参数属于脚本作用域，于是
# `$script:systemSound = ''` 会把刚传进来的参数值直接清空。
# 表现为 `-SystemSound auto` 静默失效、照旧去选语音包。
# 这个坑极隐蔽：语法合法、无任何报错，只有插探针逐行比对才看得出来。
$script:sysToneName = ''
if ($SystemSound) {
  if ($SystemSound -eq 'auto') {
    # ⚠️ 也不能用 `$script:sysToneName = switch (...)` —— PowerShell 里 switch
    # 作为赋值表达式时，在 `if` 块内**不会返回值**，变量保持空串。
    # 改用普通 if 链（这个也实测踩过）。
    if ($Kind -eq 'fail') { $script:sysToneName = 'Hand' }
    elseif ($Kind -eq 'chime') { $script:sysToneName = 'Exclamation' }
    elseif ($Kind -eq 'question') { $script:sysToneName = 'Question' }
    elseif ($Kind -eq 'approval') { $script:sysToneName = 'Question' }
    else { $script:sysToneName = 'Asterisk' }
  } else {
    $script:sysToneName = $SystemSound
  }
}

# ── 选音（旧 dsh-notify.ps1 L76-120 的裁剪版）────────────────────────────────
# kind=chime：不选语句，只走系统蜂鸣。
# done → voiceLines 根目录；question/approval/fail → voiceLines\<kind>\ 子池。
# 命名用 ~ 作变体分隔符（音色 key 允许 [\w-]，用 - 会前缀碰撞，旧实测教训）。
# 池名（0.4.29 起跨根查找只需要池名，不拼绝对路径）
$voicePool = ''
if ($Kind -in 'question', 'approval', 'fail') { $voicePool = $Kind }

# ⚠️ fail 池为空时的语义护栏（2026-10-17）：
# 旧逻辑的兜底链会把"池里没选到"一路回落到 $voiceDir（= done 池）甚至 master-voice.wav
# ——失败时播「主人、任務完了です！」完全相反。故 fail/chime 两类**不参与**该回落，
# 直接落到系统蜂鸣（Play-Chime），宁可"没有台词"也不误导。
$noDoneFallback = $Kind -in 'fail', 'chime'

function Pick-RandomWav([string]$dir, [string]$pattern) {
  if (-not (Test-Path -LiteralPath $dir)) { return '' }
  $files = @(Get-ChildItem -LiteralPath $dir -Filter $pattern -File -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return '' }
  return ($files | Get-Random).FullName
}

# 在**全部候选根**的指定池里随机取一个 wav。
#
# 语义与 Pick-RandomWav 一致，只是从“单目录”变成“跨根”（前面的根优先，但都参与）。
# 旧函数保留：master-voice 与梗音效池仍用单目录。
#
# v0.5.3：加了语言过滤。**过滤在跨根聚合之后做**（不是每个根各自过滤），
# 这样"用户目录里有中文、插件目录里只有日语"时，选 zh 仍能在全部根里找中文，
# 而不是在前面的根里找不到就直接判失败。
function Pick-RandomWavFromRoots([string]$Pool, [string]$Pattern) {
  $all = @()
  foreach ($root in $script:voiceRoots) {
    $dir = if ($Pool) { Join-Path $root $Pool } else { $root }
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $files = @(Get-ChildItem -LiteralPath $dir -File -Filter $Pattern -ErrorAction SilentlyContinue)
    foreach ($f in $files) { $all += $f }
  }
  if ($all.Count -eq 0) { return '' }
  # v0.5.3：语言过滤（跨根聚合之后）。过滤完为空时**退回未过滤**，
  # 宁可放一句别的语言，也不要整段静音 —— 提醒不响比语言跳更糟。
  $filtered = @(Select-WavByLang $all $Lang)
  if ($filtered.Count -gt 0) { $all = $filtered }
  return ($all | Get-Random).FullName
}

# 在全部候选根里找某个精确文件名（前面的根优先）。
function Find-InVoiceRootsExact([string]$Pool, [string]$FileName) {
  foreach ($root in $script:voiceRoots) {
    $dir = if ($Pool) { Join-Path $root $Pool } else { $root }
    $p = Join-Path $dir $FileName
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  return ''
}

# v0.5.3：按语言过滤 wav 列表。
#
# 约定（唯一事实源）：中文音色的 key 一律以 `zh-` 开头（zh-low-male / zh-mid-male /
# zh-clear-female / zh-soft-female），日语 VOICEVOX 音色不带该前缀。
# release-build.ps1 的 $NeverShipVoicePrefixes 与 lib/client.js 的 VOICE_KEYS
# 都按同一约定划分，测试 cross-check 防漂移。
#
# ⚠️ 用文件名前缀而不是维护第二份语言清单：清单会漂移，前缀是命名契约本身。
function Select-WavByLang($Files, [string]$Lang) {
  if (-not $Lang) { return $Files }
  if ($Lang -eq 'zh') { return @($Files | Where-Object { $_.Name -like 'zh-*' }) }
  if ($Lang -eq 'ja') { return @($Files | Where-Object { $_.Name -notlike 'zh-*' }) }
  return $Files
}

$picked = ''
# 自定义音频的上限（v0.4.8）。
#
# 为什么要限：提醒音是"打断你一下"的东西，不是播客。用户完全可能
# 误选一个几十分钟的音频或几十 MB 的文件，后果是：
#   · 播放期间一直占着 MCI 会话，后续提醒排队甚至被 spawn 上限丢弃
#   · 你可能以为插件坏了（"怎么一直在放声音"）
# 所以按**体积**先挡一道（便宜、无需解码），播之前再按**时长**挡一道。
$MaxCustomBytes = 8MB          # 8 MB 足够放 2~3 分钟的高质量 wav/mp3
$MaxCustomSeconds = 30         # 提醒音最多 30 秒
# 供 Play-VoiceLine 里的时长闸使用（函数体在下方，需是 script 作用域）
$script:maxCustomSeconds = $MaxCustomSeconds

# v0.4.4：用户指定了文件 → 直接用它，跳过整个选音链。
# 这是最强意图：他要放这个文件，任何兜底替换都是错的。
# 文件不存在/超限时**不静默** —— 落到系统提示音（按事件语义选），并留日志。
#
# 说明：这里用**函数**而不是脚本块（& $sb）。PowerShell 5.1 里脚本块紧跟
# 多行 `-f` 格式化串时容易报"缺少右括号"（实测踩到），函数更稳且可读。
function Set-FallbackToneByKind {
  if ($script:sysToneName) { return }
  if ($Kind -eq 'fail') { $script:sysToneName = 'Hand' }
  elseif ($Kind -eq 'question' -or $Kind -eq 'approval') { $script:sysToneName = 'Question' }
  elseif ($Kind -eq 'chime') { $script:sysToneName = 'Exclamation' }
  else { $script:sysToneName = 'Asterisk' }
}

if ($CustomFile) {
  if (-not (Test-Path -LiteralPath $CustomFile -PathType Leaf)) {
    Set-FallbackToneByKind
    Write-Host ("[dsh-notify-say] 自定义音频不存在，改用系统提示音: " + $CustomFile) -ForegroundColor Yellow
  } else {
    $cfInfo = Get-Item -LiteralPath $CustomFile
    if ($cfInfo.Length -gt $MaxCustomBytes) {
      Set-FallbackToneByKind
      $mb = [math]::Round($cfInfo.Length / 1MB, 1)
      Write-Host ("[dsh-notify-say] 自定义音频过大（" + $mb + " MB），改用系统提示音") -ForegroundColor Yellow
    } else {
      $picked = $cfInfo.FullName
    }
  }
}


# v0.4.2：指定了系统提示音就**完全不碰语音池**。
# 否则 -Kind fail 会先选到 fail 池的 wav，系统音效分支永远走不到
# （实测：`-Kind fail -SystemSound auto` 播了语音包而不是警告音）。
#
# v0.4.4 追加 `-not $picked`：-CustomFile 已经定好了要播的文件，
# 这里不能再被语音池覆盖（否则用户选的文件形同虚设）。
if ($Kind -ne 'chime' -and -not $script:sysToneName -and -not $picked) {
  $wantVoice = $Voice
  if ($Mode -eq 'random') { $wantVoice = '' }
  if ($wantVoice -and $wantVoice -notmatch '^\w[\w-]*$') { $wantVoice = '' }
  if ($wantVoice) {
    $picked = Pick-RandomWavFromRoots $voicePool ($wantVoice + '~*.wav')
    if (-not $picked) {
      $pf = Find-InVoiceRootsExact $voicePool ($wantVoice + '.wav')
      if ($pf) { $picked = $pf }
    }
    # fail/chime 的池内兜底（2026-10-17，独立复核 I-1 提出后补）：
    # fail 池只覆盖 16 个基础音色，而 done 池有 103 个 key（含 -kansai-N / -extra-N 变体）。
    # 用户在 tools\set-voice.ps1 里切到未覆盖的 key 时，若这里直接放弃 → 失败时整句台词消失、
    # 只剩蜂鸣。语义上"换个音色说同样的道歉话"远好于"没有台词"，故在**同一子池内**退一步随机取。
    # 注意：这是**池内**回落，绝不越到 done 池（越池由下方 $noDoneFallback 拦截）。
    if (-not $picked -and $noDoneFallback) { $picked = Pick-RandomWavFromRoots $voicePool '*.wav' }
    # done 池根目录的 <voice>.wav 只对 done 有意义；fail 池缺该音色时不该去 done 池找
    if (-not $picked -and -not $noDoneFallback) {
      $pf = Find-InVoiceRootsExact '' ($wantVoice + '.wav')
      if ($pf) { $picked = $pf }
    }
  } else {
    $picked = Pick-RandomWavFromRoots $voicePool '*.wav'
    if (-not $picked -and -not $noDoneFallback) { $picked = Pick-RandomWavFromRoots '' '*.wav' }
  }
  # master-voice.wav 说的是"任務完了"，对 fail 同样语义相反 → 跳过
  if (-not $picked -and -not $noDoneFallback) {
    $master = Join-Path $SoundDir 'master-voice.wav'
    if (Test-Path -LiteralPath $master) { $picked = $master }
  }
  # 随机梗音效池同理：那是"完成"的庆祝音，失败时不该播
  if (-not $picked -and -not $noDoneFallback) {
    $pool = @(Get-ChildItem -LiteralPath $SoundDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.mp3', '.wav' })
    if ($pool.Count -gt 0) { $picked = ($pool | Get-Random).FullName }
  }
}
$script:playFile = $picked

try {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class DshNotifyMci {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, StringBuilder ret, int retLen, System.IntPtr hWnd);
}
'@ -ErrorAction Stop
} catch { }

# 日志：best-effort 落 %TEMP%（不写插件包/profile 目录，避免污染安装物）
$logFile = ''
try {
  $logDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-notify-say'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
  $logFile = Join-Path $logDir 'notify.log'

# v0.4.34：写一行日志。$detail = 含用户内容（标题/正文），只在 debug 档写。
#
# 用函数而不是内联 Add-Content：三处调用点都要同样判断，
# 内联会让"某处忘了判断"这种遗漏很难看出来。
function Write-NotifyLog([string]$KindTag, [string]$Extra, [string]$Detail) {
  if (-not $logFile) { return }
  try {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $parts = @($ts, "[$KindTag]", $Extra)
    if ($Detail) {
      if ($LogLevel -eq 'debug') { $parts += $Detail }
      else { $parts += '(内容已隐藏，需 -LogLevel debug)' }
    }
    Add-Content -Path $logFile -Value (($parts -join ' ').Trim()) -Encoding utf8
  } catch { }
}
  # 审查建议采纳：容量护栏——超过 512KB 整文件重建（best-effort 诊断日志，不做轮转）
  if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue).Length -gt 524288)) {
    Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
  }
} catch { }

# Toast：整块点击走官方协议 dsh://open 唤窗（2026-09-25 按用户决定移除按钮——整块可点后冗余；
# 官方壳不解析会话参数）。
# 2026-09-25 补 <toast> 元素 activationType="protocol"：默认 foreground 只会把 launch
# 传给"关联 app"（借用的 RunDialog AUMID 不消费 URL → 整块点击无效；根因记载于旧
# tools\dsh-notify.ps1 2026-08-30 注释）；protocol 激活由 shell 直接处理，与 AUMID 无关。
# 标题/正文先 XML 转义：含 & < > 时直接拼 XML 会让 LoadXml 抛错、Toast 静默失败（旧踩坑 #23）。
# 2026-09-25 样式统一：发通知身份改用官方壳 AUMID com.deepseek.dsh（来源名 "DeepSeek Harness"、
# 角标随壳图标）；备选未采用：desktop\assets\icon.png 做 appLogoOverride 角标（旧 ps1 2026-09-03 做法）。
$xmlEscape = { param([string]$s) ([string]$s).Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;') }
  $titleXml = & $xmlEscape $Title
  $bodyXml = & $xmlEscape $Body
  # 第三行按需拼接：没有 -Detail 就不加 <text>，模板还是两行。
  $detailXml = ""
  if ($Detail -ne "") { $detailXml = "<text>" + (& $xmlEscape $Detail) + "</text>" }

if ($SoundOnly -or $Preview) {
  # 视觉另有消费方（或试听）：只播声音，不弹 Toast
  $shown = $true
} else {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
      # v0.4.70：launch 按「是否拿到会话 id」决定。
      #
      # 为什么用自有协议：dsh://open 是 DSH 本体硬编码的精确匹配，**加参数连窗口都不拉**。
      # dshnotify-say://jump?session=<id> 由插件的 jump-handler.ps1 处理，能精确识别会话；
      # 它内部再调 dsh://open 复用官方唤窗，所以窗口该起还是会起。
      #
      # 会话 id 白名单校验：只接受字母数字/下划线/连字符，杜绝把怪字符拼进 XML。
      $toastLaunch = 'dsh://open'
      if ($SessionId -and ($SessionId -match '^[A-Za-z0-9_-]{4,128}$')) {
        $toastLaunch = 'dshnotify-say://jump?session=' + $SessionId
      }
      $launchXml = (& $xmlEscape $toastLaunch)
      $xml.LoadXml("<toast activationType=`"protocol`" launch=`"$launchXml`"><visual><binding template=`"ToastGeneric`"><text>$titleXml</text><text>$bodyXml</text>$detailXml</binding></visual></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    # 2026-10-25：发通知身份改成**按本机实际注册的 AUMID 解析**，不再写死 com.deepseek.dsh。
    #
    # 为什么：官方壳的 AUMID 并非处处一致 —— 官方安装包注册 com.deepseek.dsh，
    # 而 Electron 默认身份（开始菜单快捷方式里带的正是它）是 electron.app.<ProductName>。
    # 一旦这里写死的那个没在本机注册，Windows 仍会收下 Toast（**不抛异常**，所以原有
    # try/catch 兜不住），但会把 **AUMID 原文当应用名印上去、且画不出名字旁边的小图标**。
    # 用户实测截图里标题行就是 "com.deepseek.dsh"。
    #
    # 解析顺序见 Get-ToastAppId：磁盘缓存 → Get-StartApps 里注册为「DeepSeek Harness」
    # 的项 → 退回历史行为。缓存是必要的：本机实测 Get-StartApps 约 540ms，
    # 每条通知都跑一次会让提示音明显滞后。
    $toastAumids = @(Get-ToastAppId)
    foreach ($toastAumid in $toastAumids) {
      try {
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($toastAumid).Show($toast)
        $shown = $true
        break
      } catch { }
    }
  } catch { $shown = $false }
}

# ── 发通知用的 AUMID 解析（2026-10-25）────────────────────────────────────
#
# 为什么要探测而不是写死：见调用处的注释 —— AUMID 没注册时 Toast 不报错，
# 只是把 AUMID 原文当应用名、且没有小图标，属于"静默降级"，最难排查的那类。
#
# 为什么要缓存：本机实测 Get-StartApps 约 540ms，而 ps1 是**每条通知起一个进程**，
# 不缓存就等于每条通知都晚半秒出声。缓存文件 %LOCALAPPDATA%\dsh-notify-say\toast-aumid.txt
# 只有一行；删掉它即强制重新探测（换安装包或换机器后排查用）。
function Get-ToastAppId {
  $cacheDir = Join-Path $env:LOCALAPPDATA 'dsh-notify-say'
  $cacheFile = Join-Path $cacheDir 'toast-aumid.txt'

  # 1) 缓存命中：0 成本
  try {
    if (Test-Path -LiteralPath $cacheFile) {
      $cached = (Get-Content -LiteralPath $cacheFile -Raw -ErrorAction Stop).Trim()
      if ($cached) { return @($cached) }
    }
  } catch { }

  # 2) 探测：开始菜单里注册为「DeepSeek Harness」的那一项，AppID 就是 Windows
  #    用来找图标与显示名的 AUMID。
  $found = @()
  try {
    $hit = Get-StartApps -ErrorAction Stop |
      Where-Object { $_.Name -match 'DeepSeek\s*Harness' -or $_.AppID -match 'deepseek' } |
      Select-Object -First 1
    if ($hit -and $hit.AppID) { $found += [string]$hit.AppID }
  } catch { }

  # 3) 兜底：历史写死的身份 + 借用身份。探测不到时行为与改动前完全一致。
  $found += @('com.deepseek.dsh', 'Microsoft.Windows.Shell.RunDialog')

  # 去重保序
  $seen = @{}
  $list = @()
  foreach ($id in $found) {
    if ($id -and -not $seen.ContainsKey($id)) {
      $seen[$id] = $true
      $list += $id
    }
  }

  # 只缓存"探测成功"的结果；纯兜底不写缓存，避免一次探测失败被永久固化。
  if ($list.Count -gt 2) {
    try {
      New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
      Set-Content -LiteralPath $cacheFile -Value $list[0] -Encoding ASCII -NoNewline
    } catch { }
  }
  return $list
}

function global:Play-Chime {
  try {
    # ⚠️ 音量 0 必须**完全静音**（2026-10-17 修）。
    # 原因：[console]::Beep 无法控制音量，SystemSounds.Play() 走系统音量，
    # 两者都无视 -Volume。于是 `-Volume 0`（自动化测试 / 静音验证常用）
    # 在 chime 路径上照样出声 —— 实测导致跑测试时用户连续听到蜂鸣。
    if ($script:notifyVol -eq 0) { return }

    # v0.4.2：用户指定了系统提示音（或 auto 按语义映射）→ 只播那个，不叠蜂鸣。
    # 「失败」和「完成」用同一个音会让人误判，故必须按语义区分。
    if ($script:sysToneName) {
      $name = $script:sysToneName
      try {
        [System.Media.SystemSounds]::$name.Play()
        $script:lastSound = 'sys:' + $name
        return
      } catch {
        # 名字不合法就落到下面的默认蜂鸣，不要静默
      }
    }

    1..2 | ForEach-Object {
      [console]::Beep(987, 350); Start-Sleep -Milliseconds 120
      [console]::Beep(1319, 350); Start-Sleep -Milliseconds 120
      [console]::Beep(987, 650); Start-Sleep -Milliseconds 350
    }
    [System.Media.SystemSounds]::Asterisk.Play()
  } catch { }
}

function global:Play-VoiceLine {
  if ($Kind -eq 'chime') { Play-Chime; return }
  if (-not $script:playFile) { Play-Chime; return }

  # ── 时长/体积闸（v0.4.8）──────────────────────────────────────────────────
  #
  # ⚠️ 必须放在**静音 return 之前**。
  # 第一版把它写在 MCI open 之后，而 -Volume 0 会在那之前就 return，
  # 于是静音模式（自动化测试、以及"想静音验证"的用户）永远绕过了这道闸 ——
  # 实测时探针打不出来才发现。
  #
  # 提醒音不是播客：用户可能误选几十分钟的音频。播放期间会一直占着 MCI 会话，
  # 后续提醒排队甚至被 spawn 上限丢弃，而且用户会以为插件坏了。
  # 这里用**体积**快速挡（无需解码），再看**时长**（挡"小但很长"的低码率文件）。
  if ($CustomFile) {
    $guardOk = $true
    try {
      $gi = Get-Item -LiteralPath $script:playFile -ErrorAction Stop
      if ($gi.Length -gt $MaxCustomBytes) {
        $mbG = [math]::Round($gi.Length / 1MB, 1)
        Write-Host ("[dsh-notify-say] 自定义音频过大（" + $mbG + " MB），改用系统提示音") -ForegroundColor Yellow
        $guardOk = $false
      }
    } catch { $guardOk = $false }

    if ($guardOk) {
      # 时长检查要打开 MCI，单独用一个临时别名，查完立刻关闭
      try {
        $ga = 'dshchk' + (Get-Random -Maximum 100000)
        $go = [DshNotifyMci]::mciSendString('open "' + $script:playFile + '" alias ' + $ga + ' wait', $null, 0, [IntPtr]::Zero)
        if ($go -eq 0) {
          $lenBuf = New-Object System.Text.StringBuilder 64
          $q = [DshNotifyMci]::mciSendString('status ' + $ga + ' length', $lenBuf, $lenBuf.Capacity, [IntPtr]::Zero)
          if ($q -eq 0) {
            $lenMs = 0
            if ([int]::TryParse($lenBuf.ToString().Trim(), [ref]$lenMs) -and $lenMs -gt ($script:maxCustomSeconds * 1000)) {
              $secG = [math]::Round($lenMs / 1000, 1)
              Write-Host ("[dsh-notify-say] 自定义音频过长（" + $secG + " 秒），改用系统提示音") -ForegroundColor Yellow
              $guardOk = $false
            }
          }
          [void][DshNotifyMci]::mciSendString('close ' + $ga, $null, 0, [IntPtr]::Zero)
        }
        # 打不开就不判（fail-visible：宁可放行，也不要因查询失败而静音）
      } catch { /* 查询失败放行 */ }
    }

    if (-not $guardOk) {
      Set-FallbackToneByKind
      $script:playFile = ''      # 转走系统提示音
    }
  }

  if ($Kind -eq 'chime' -or -not $script:playFile) { Play-Chime; return }

  # ⚠️ 音量 0 = 完全静音（2026-10-17 修）。两个实测坑：
  #   1. MCI 的 `setaudio volume to 0` 并非静音（0 常被当作未设/最大），
  #      于是"传 -Volume 0 想静音"的自动化测试照样出声；
  #   2. 一旦播放在 catch 里失败，会回落到 Play-Chime —— 更响。
  # 所以在**打开文件之前**就返回，且不回落 chime。
  if ($script:notifyVol -eq 0) { $script:lastSound = ''; return }
  $fx = Get-Item -LiteralPath $script:playFile
  $script:lastSound = $fx.Name
  if ($fx.FullName -match '"') { $script:lastSound = ''; Play-Chime; return }

  # ── 数字增益（v0.4.16）────────────────────────────────────────────────────
  #
  # MCI 音量上限 = 原始幅度 1.0 倍，无法把偏轻的素材补响。
  # 这里先把样本乘以系数、写到临时 wav 再播。
  #
  # `-Gain` 是**期望倍数**，实际系数还会按峰值限幅（不超过 95% 峰值）：
  #   · 素材本来就响（如 84%）→ 自动降到安全倍数，不会削波
  #   · 素材偏轻（如 25%）→ 放足指定倍数
  # 只对 16-bit PCM wav 生效；其它格式（mp3 等）原样播放。
  #
  # 实测依据：本包 247 个语音包峰值 最小 24.7% / 中位 40.4% / 最大 84.4%。
  # 2.0 倍把中位补到 ~80%，既明显变响又不冒削波风险。
  $gainTmp = ''
  try {
    if ($Gain -gt 1.0 -and (Get-Command Invoke-WavGain -ErrorAction SilentlyContinue)) {
      $gainTmp = Join-Path $env:TEMP ('dsh-gain-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.wav')
      $g = Invoke-WavGain -Path $fx.FullName -OutPath $gainTmp -Gain $Gain
      if ($g.Ok) {
        $fx = Get-Item -LiteralPath $gainTmp
        # ⚠️ 不要用跨行的 `-f` 格式化串：PowerShell 5.1 在 Write-Host (...) 里
        # 解析失败，报"缺少右括号"（本项目已踩过三次）。先算变量再拼最稳。
        $msg = '[dsh-notify-say] 增益 x' + $g.AppliedGain + '（峰值 ' + $g.PeakBefore + '% -> ' + $g.PeakAfter + '%）'
        Write-Host $msg -ForegroundColor DarkGray
      } else {
        # 不支持的格式 / 本来就够响 / 出错 —— 都用原文件，绝不因此静音
        if (Test-Path -LiteralPath $gainTmp) { Remove-Item -LiteralPath $gainTmp -Force -ErrorAction SilentlyContinue }
        $gainTmp = ''
      }
    }
  } catch {
    if ($gainTmp -and (Test-Path -LiteralPath $gainTmp)) { Remove-Item -LiteralPath $gainTmp -Force -ErrorAction SilentlyContinue }
    $gainTmp = ''
  }

  try {
    $alias = 'dshnote' + (Get-Random -Maximum 100000)
    $open = [DshNotifyMci]::mciSendString('open "' + $fx.FullName + '" alias ' + $alias + ' wait', $null, 0, [IntPtr]::Zero)
    if ($open -ne 0) { throw "MCI open failed: $open" }

    if ($null -ne $script:notifyVol) {
      [void][DshNotifyMci]::mciSendString('setaudio ' + $alias + ' volume to ' + ($script:notifyVol * 10), $null, 0, [IntPtr]::Zero)
    }
    $rc = [DshNotifyMci]::mciSendString('play ' + $alias + ' wait', $null, 0, [IntPtr]::Zero)
    [void][DshNotifyMci]::mciSendString('close ' + $alias, $null, 0, [IntPtr]::Zero)
    if ($rc -ne 0) { throw "MCI play failed: $rc" }
  } catch { $script:lastSound = ''; Play-Chime }
  finally {
    # 增益临时文件用完就删（无论播放成功与否）
    if ($gainTmp -and (Test-Path -LiteralPath $gainTmp)) {
      try { Remove-Item -LiteralPath $gainTmp -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
}

$pickedName = if ($script:playFile) { Split-Path $script:playFile -Leaf } else { if ($Kind -eq 'chime') { 'chime' } else { 'none' } }

if ($Preview) {
  if (-not $NoSound) { Play-VoiceLine }
  $soundTag = if ($NoSound) { '（静音）' } elseif ($script:lastSound) { " + 音效 $script:lastSound" } else { ' + 兜底提示音' }
  Write-NotifyLog 'preview' ("-Voice $Voice pick=$pickedName$soundTag") ''
  Write-Host ("[dsh-notify-say] OK 试听 [$Kind] pick=" + $pickedName + $soundTag) -ForegroundColor Green
} elseif ($shown) {
  if (-not $NoSound) { Play-VoiceLine }
  $soundTag = if ($NoSound) { '（静音）' } elseif ($script:lastSound) { " + 音效 $script:lastSound" } else { ' + 兜底提示音' }
  Write-NotifyLog 'toast' ("pick=$pickedName$soundTag") ("title=$Title body=$Body")
  Write-Host ("[dsh-notify-say] OK Toast [$Kind] pick=" + $pickedName + $soundTag) -ForegroundColor Green
} else {
  if (-not $NoSound) { Play-VoiceLine }
  $soundTag = if ($NoSound) { '（静音）' } elseif ($script:lastSound) { " + 音效 $script:lastSound" } else { ' + 兜底提示音' }
  Write-NotifyLog 'FALLBACK' ("pick=$pickedName$soundTag") ("title=$Title body=$Body")
  Write-Host ("[dsh-notify-say] (Toast 不可用，走兜底) [$Kind] pick=" + $pickedName + $soundTag) -ForegroundColor Yellow
}
