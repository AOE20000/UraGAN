<#
.SYNOPSIS
  UraGAN 便携分发包安装/卸载（Windows）。
  把 build/uragan 拷到 %LOCALAPPDATA%\UraGAN，并把 bin 目录加入用户 PATH。
.DESCRIPTION
  先运行 `pnpm pack` 生成便携分发包（build/uragan），再执行本脚本安装。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-portable.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-portable.ps1 -Uninstall
#>
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\build\uragan'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'UraGAN'),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if ($Uninstall) {
  $bin = Join-Path $InstallDir 'bin'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -and $userPath.Contains($bin)) {
    $parts = @($userPath.Split(';') | Where-Object { $_ -and $_ -ne $bin })
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    Write-Step "已从用户 PATH 移除：$bin"
  }
  if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Step "已删除安装目录：$InstallDir"
  } else {
    Write-Host "未安装，跳过删除。"
  }
  Write-Host "卸载完成。已打开的终端需重启以刷新 PATH。" -ForegroundColor Yellow
  exit 0
}

if (-not (Test-Path $Source)) {
  Write-Error "未找到便携分发包：$Source`n请先在仓库根运行：pnpm pack"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error '未检测到 node，请先安装 Node.js ≥ 20 并确保 node 在 PATH 中。'
}

# 1) 拷贝分发包
Write-Step "拷贝分发包 → $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
# /MIR 保持目标与源一致（更新时清理老文件），/NFL /NDL 静默文件列表
robocopy $Source $InstallDir /E /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy 失败（exit=$LASTEXITCODE）" }

# 2) 注册用户 PATH
$bin = Join-Path $InstallDir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -and $userPath.Split(';') -contains $bin) {
  Write-Step "PATH 已包含：$bin"
} else {
  $next = if ($userPath) { "$userPath;$bin" } else { $bin }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  Write-Step "已加入用户 PATH：$bin"
}

# 3) 验证
Write-Step "验证安装（version）"
& (Join-Path $bin 'uragan.cmd') --version

Write-Host ""
Write-Host "✔ UraGAN 已安装到：$InstallDir" -ForegroundColor Green
Write-Host "  新开终端即可使用（当前窗口可手动刷新 PATH）："
Write-Host "    uragan        - CLI / TUI（uragan tui）"
Write-Host "    uragan-mcp    - MCP Server（TRAE 配置 command 可直接指向该入口）"
Write-Host "  卸载：powershell -ExecutionPolicy Bypass -File scripts\install-portable.ps1 -Uninstall"