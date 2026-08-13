$ErrorActionPreference = "Stop"
$noPause = $args -contains "--no-pause"
$exitAfterStartup = $args -contains "--once"
$env:ZHUOMIANLING_STARTUP_TIMING = "1"
$env:ZHUOMIANLING_STARTUP_STARTED_AT = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$env:ZHUOMIANLING_VISION_TIMING = "1"
$env:VITE_SCREEN_MONITOR_DEBUG = "1"
if ($exitAfterStartup) {
  $env:ZHUOMIANLING_STARTUP_EXIT_AFTER_SPLASH = "1"
}

Write-Host ""
Write-Host "[TIMED DIAGNOSTICS TEST MODULE] 启动脚本已开始，计时数据将显示在主页‘监测’页面。"
Write-Host "[TIMED DIAGNOSTICS TEST MODULE] 应用启动后点击主页顶部‘监测’，可查看四项测试和最近 10 次请求。"
Write-Host "[视觉计时] TIMED DIAGNOSTICS TEST MODULE 已开启。请在主页顶部打开‘监测’查看四项测试。"
Write-Host "[视觉计时] 普通聊天、主动识图和自动检测屏幕的阶段耗时会实时进入前端，不再输出计时日志。完成后可按 Ctrl+C 退出。"
Write-Host ""

& npm.cmd run dev
$devExitCode = $LASTEXITCODE

Write-Host ""
Write-Host "[TIMED DIAGNOSTICS TEST MODULE] 开发进程已退出，代码 $devExitCode。"
Write-Host "[视觉计时] 开发进程已退出，代码 $devExitCode。"

if (-not $noPause) {
  Read-Host "按 Enter 关闭此窗口"
}

exit $devExitCode
