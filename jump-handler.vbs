' DSH 通知插件 —— 协议处理器包装（v0.4.78）
'
' ## 为什么用 VBS 而不是直接调 powershell.exe
'
' 1. **不弹命令行窗口**
'    wscript.exe 是 GUI 子系统程序，本身不创建控制台。
'    而 `powershell.exe -WindowStyle Hidden` 在协议调起场景下**仍会闪窗／
'    留下可见控制台**（Windows 已知行为：-WindowStyle 只影响 PS 自己的
'    宿主窗口，不改父进程传给子进程的 console）。
'    2026-10-20 用户实测多次报告"点 Toast 打开一个命令行窗口"。
'
' 2. **启动更快**
'    不走 PowerShell 冷启动（约 300–800ms），VBS 几毫秒。
'
' 3. **参数传递可靠**
'    协议调起时 Windows 传给 "%1" 的是完整 URL；VBS 的 WScript.Arguments
'    能原样拿到，不需要经过 powershell 的参数解析（那层会吃掉引号/& 之类）。
'
' ## 它做什么
'
'   ① 解析 dshnotify-say://jump?session=<id>
'   ② 找插件端口（port.txt，或扫描能响应 /version 的端口）
'   ③ POST /api/dsh-notify-say/pending-jump（带 Origin 头，过 http-guard）
'   ④ 调 dsh://open 把 DSH 唤到前台（用 Run 的第二参数 0 = 隐藏窗口）
'
' ## 安全
'
'   只接受 dshnotify-say://jump?session=<白名单字符>，其它一律静默退出。
'
' ## v0.5.0 协议改名
'
'   协议名从 dshnotify 改为 dshnotify-say（见 lib/index.js 的 JUMP_PROTOCOL）。
'   匹配**只认新名**：老键由插件启动时清掉，这里不必兼容旧 URL。

Option Explicit

Dim url, sid, port, candidates, i, ok, logPath, fso

Set fso = CreateObject("Scripting.FileSystemObject")

' ── 诊断日志（放在 %TEMP%，与插件主日志同目录）──────────────────────────
Sub LogLine(msg)
  On Error Resume Next
  Dim ts, dir, f
  dir = fso.GetSpecialFolder(2).Path & "\dsh-notify-say"
  If Not fso.FolderExists(dir) Then fso.CreateFolder(dir)
  logPath = dir & "\jump-handler.log"
  Set ts = fso.OpenTextFile(logPath, 8, True)
  ts.WriteLine Now & " " & msg
  ts.Close
  On Error GoTo 0
End Sub

' ── 1. 取参数 ─────────────────────────────────────────────────────────────
If WScript.Arguments.Count = 0 Then
  LogLine "[skip] no args"
  WScript.Quit 0
End If

url = WScript.Arguments(0)
LogLine "[recv] """ & url & """"

' ── 2. 解析 session ──────────────────────────────────────────────────────
sid = ""
Dim m
Set m = New RegExp
m.IgnoreCase = True
m.Pattern = "^dshnotify-say://jump/?(\?(.*))?$"
If Not m.Test(url) Then
  LogLine "[skip] url not matched"
  WScript.Quit 0
End If

Dim query
query = ""
Set m = New RegExp
m.IgnoreCase = True
m.Pattern = "\?(.*)$"
If m.Test(url) Then query = m.Execute(url)(0).SubMatches(0)

Set m = New RegExp
m.IgnoreCase = True
m.Pattern = "(^|&)session=([^&]+)"
If m.Test(query) Then
  sid = m.Execute(query)(0).SubMatches(1)
End If

' 白名单：只接受字母数字/下划线/连字符（4-128 位）
If sid <> "" Then
  Set m = New RegExp
  m.Pattern = "^[A-Za-z0-9_-]{4,128}$"
  If Not m.Test(sid) Then
    LogLine "[skip] bad session id: """ & sid & """"
    sid = ""
  End If
End If

LogLine "[parse] sid=" & sid
If sid = "" Then WScript.Quit 0

' ── 3. 找端口 ────────────────────────────────────────────────────────────
' 优先 port.txt（插件在注册路由时写入）
port = 0
On Error Resume Next
Dim ts2, txt
Dim shEnv, localAppData, p1
Set shEnv = CreateObject("WScript.Shell")
localAppData = shEnv.ExpandEnvironmentStrings("%LOCALAPPDATA%")
If localAppData = "" Or InStr(localAppData, "%") > 0 Then
  ' 兜底：TEMP 的上一级就是 LOCALAPPDATA
  localAppData = fso.GetSpecialFolder(2).ParentFolder.Path
End If
p1 = localAppData & "\dsh-notify-say\port.txt"
LogLine "[port] looking at " & p1
If fso.FileExists(p1) Then
  Set ts2 = fso.OpenTextFile(p1, 1)
  txt = Trim(ts2.ReadAll)
  ts2.Close
  If IsNumeric(txt) Then port = CLng(txt)
  LogLine "[port] from port.txt=" & port
Else
  LogLine "[port] port.txt not found"
End If
On Error GoTo 0

' 候选端口：port.txt 优先，再补常见/历史端口
candidates = ""
If port > 0 Then candidates = CStr(port)
Dim extra
extra = Array("55510", "58163", "59525", "53523", "50061", "19387")
For i = 0 To UBound(extra)
  If InStr("," & candidates & ",", "," & extra(i) & ",") = 0 Then
    If candidates = "" Then
      candidates = extra(i)
    Else
      candidates = candidates & "," & extra(i)
    End If
  End If
Next

' ── 4. POST pending-jump ────────────────────────────────────────────────
Dim ports
ports = Split(candidates, ",")
ok = False

For i = 0 To UBound(ports)
  If Not ok Then
    Dim px, body, httpResp
    px = ports(i)
    If IsNumeric(px) And CLng(px) > 0 Then
      On Error Resume Next
      body = "{""sessionId"":""" & sid & """,""at"":" & CStr(Now * 86400000) & "}"
      ' 正确的毫秒时间戳（VBS 没有 Date.now，用 Timer 不够，用 DateDiff）
      Dim epochMs
      epochMs = DateDiff("s", #1/1/1970#, Now()) * 1000
      body = "{""sessionId"":""" & sid & """,""at"":" & CStr(epochMs) & "}"

      Set httpResp = CreateObject("MSXML2.XMLHTTP.6.0")
      httpResp.Open "POST", "http://127.0.0.1:" & px & "/api/dsh-notify-say/pending-jump", False
      httpResp.setRequestHeader "Origin", "http://127.0.0.1:" & px
      httpResp.setRequestHeader "Content-Type", "application/json"
      httpResp.Send body
      If httpResp.Status = 200 Then
        LogLine "[posted] port=" & px & " status=" & httpResp.Status
        ok = True
      Else
        LogLine "[post-fail] port=" & px & " status=" & httpResp.Status
      End If
      On Error GoTo 0
    End If
  End If
Next

If Not ok Then LogLine "[warn] no port accepted the POST"

' ── 5. 唤窗（第二参数 0 = 隐藏窗口）────────────────────────────────────
On Error Resume Next
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c start """" dsh://open", 0, False
LogLine "[open] dsh://open"
On Error GoTo 0
