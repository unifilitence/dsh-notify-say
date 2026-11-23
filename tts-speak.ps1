<#
.SYNOPSIS
  用 Windows 自带语音合成（SAPI）朗读一句台词。零下载、零依赖。

.DESCRIPTION
  ## 为什么要有它

  插件发布时不可能带 48 MB 的语音包；而用户「什么都不下载」时也应当**有声音**。
  Windows 自带 SAPI 提供中英文发音人，实测合成一句话仅 **54 ms**，
  完全可以在播报时实时合成，不需要预生成任何音频文件。

  ## 台词为什么是中文

  本机实测发音人只有：
    Microsoft Huihui / Kangkang / Yaoyao（zh-CN）、Microsoft Zira（en-US）
  **没有任何日语发音人**（Windows 的日语语音需另装语言包，且只装在 OneCore 里，
  SAPI 的 System.Speech 访问不到）。所以用中文台词，而不是硬读日文——
  中文发音人念日文会读成四不像。

  ## 为什么输出到临时 wav 再播，而不是直接 Speak()

  `SpeechSynthesizer.Speak()` 是同步阻塞的。本脚本由宿主 spawn 调起，
  若直接 Speak，脚本要等语音播完才退出，期间占着进程。
  写到临时 wav 再用 MCI 播放（与语音包走同一条播放路径），
  就能统一音量控制（MCI setaudio），也让失败时能优雅回退。

.PARAMETER Text
  要朗读的文字。

.PARAMETER VoiceName
  发音人名（如 "Microsoft Huihui Desktop"）。留空则用系统默认。
  传 "list" 则只列出可用发音人并退出。

.PARAMETER Rate
  语速 -10..10，0 为正常。

.PARAMETER Volume
  音量 0-100（-1 跟随系统）。

.PARAMETER Preview
  试听模式：只播放，不写通知日志。

.EXAMPLE
  powershell -File tts-speak.ps1 -Text "任务完成了" -Preview

.EXAMPLE
  # 看本机有哪些发音人
  powershell -File tts-speak.ps1 -VoiceName list
#>
[CmdletBinding()]
param(
  [string]$Text = '任务完成了',
  [string]$VoiceName = '',
  [ValidateRange(-10, 10)]
  [int]$Rate = 0,
  [int]$Volume = -1,
  [switch]$Preview
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$msg) {
  if ($Preview) { return }
  try {
    # v0.5.4：与 lib/log-path.js / dsh-notify.ps1 同口径，支持覆盖目录。
    $dir = $env:DSH_NOTIFY_SAY_LOG_DIR
    if ([string]::IsNullOrWhiteSpace($dir)) {
      $dir = Join-Path $env:TEMP 'dsh-notify-say'
    } else {
      $dir = $dir.Trim()
    }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $line = ('{0} [tts] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    Add-Content -LiteralPath (Join-Path $dir 'notify.log') -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch { }
}

# ── 加载 SAPI ───────────────────────────────────────────────────────────────
try {
  Add-Type -AssemblyName System.Speech -ErrorAction Stop
} catch {
  Write-Output "[tts] FAIL 无法加载 System.Speech（Windows 语音组件不可用）：$($_.Exception.Message)"
  exit 2
}

$synth = $null
try {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

  # ── 列出可用发音人 ────────────────────────────────────────────────────────
  if ($VoiceName -eq 'list') {
    # 实测（2026-10-17）：PowerShell 5.1 的 System.Speech 只枚举到 **2 个**发音人
    # （Huihui Desktop / Zira Desktop）。注册表 HKLM\...\Speech_OneCore\Voices 下
    # 还有 Kangkang / Yaoyao / Huihui，但 SelectVoice 对它们一律失败 ——
    # 那几个只对 OneCore API（Windows.Media.SpeechSynthesis）可见，SAPI 用不了。
    # 所以如实列出能用的，不要假装有更多。
    $all = $synth.GetInstalledVoices()
    $lines = @()
    foreach ($v in $all) {
      $lines += ('  {0}|{1}|{2}' -f $v.VoiceInfo.Name, $v.VoiceInfo.Culture.Name, $v.VoiceInfo.Gender)
    }
    Write-Output ("[tts] 可用发音人 {0} 个:" -f @($all).Count)
    $lines | ForEach-Object { Write-Output $_ }
    exit 0
  }

  # ── 选发音人 ──────────────────────────────────────────────────────────────
  if ($VoiceName) {
    $hit = $null
    foreach ($v in $synth.GetInstalledVoices()) {
      if ($v.VoiceInfo.Name -eq $VoiceName) { $hit = $v.VoiceInfo.Name; break }
    }
    if ($hit) {
      $synth.SelectVoice($hit)
    } else {
      # 指定发音人不存在：不报错，用系统默认（宁可声音不对，也不要没声音）
      Write-Log "指定发音人不存在：$VoiceName，改用系统默认"
    }
  }

  $synth.Rate = $Rate

  # ── 合成到临时 wav ────────────────────────────────────────────────────────
  $tmp = Join-Path $env:TEMP ('dsh-tts-{0}.wav' -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
  try {
    $synth.SetOutputToWaveFile($tmp)
    $synth.Speak($Text)
  } finally {
    try { $synth.SetOutputToNull() } catch { }
  }

  if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -lt 1000) {
    Write-Output '[tts] FAIL 合成结果为空'
    exit 3
  }

  # ── 播放（MCI，与语音包同一条路径，便于统一音量）──────────────────────────
  try {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class DshTtsMci {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, StringBuilder ret, int retLen, System.IntPtr hWnd);
}
'@ -ErrorAction SilentlyContinue
  } catch { }

  $alias = 'dshtts'
  $open = 'open "' + $tmp + '" type waveaudio alias ' + $alias
  $rc = [DshTtsMci]::mciSendString($open, $null, 0, [IntPtr]::Zero)
  if ($rc -ne 0) {
    # 打开失败就退回 SoundPlayer（至少能出声）
    try {
      $sp = New-Object System.Media.SoundPlayer $tmp
      $sp.PlaySync()
      Write-Output '[tts] OK (SoundPlayer fallback)'
    } catch {
      Write-Output "[tts] FAIL 播放失败：$($_.Exception.Message)"
      exit 4
    }
  } else {
    if ($Volume -ge 0 -and $Volume -le 100) {
      [void][DshTtsMci]::mciSendString(('setaudio ' + $alias + ' volume to ' + ($Volume * 10)), $null, 0, [IntPtr]::Zero)
    }
    [void][DshTtsMci]::mciSendString(('play ' + $alias + ' wait'), $null, 0, [IntPtr]::Zero)
    [void][DshTtsMci]::mciSendString(('close ' + $alias), $null, 0, [IntPtr]::Zero)
    Write-Output ('[tts] OK pick={0}' -f (Split-Path $tmp -Leaf))
  }

  # 先把要记的信息取出来，再 Dispose（否则 finally 里释放后这里会读空对象）
  $usedVoice = ''
  try { $usedVoice = $synth.Voice.Name } catch { }

  Write-Log "已朗读：$Text（发音人=$usedVoice）"
  try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
  exit 0
} catch {
  Write-Output ("[tts] FAIL " + $_.Exception.Message)
  exit 1
} finally {
  if ($synth) { try { $synth.Dispose() } catch { } }
}
