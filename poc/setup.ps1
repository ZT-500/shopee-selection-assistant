# Shopee 爬虫 - 一键启动脚本
# 用法：在 PowerShell 里跑 .\setup.ps1
# 它会：1) 关掉所有 Chrome  2) 用调试端口重启 Chrome  3) 验证端口

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Shopee 爬虫 - Chrome 调试端口启动器" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. 自动找 Chrome
$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Host "[ERROR] 找不到 Chrome 安装位置。" -ForegroundColor Red
    Write-Host "        请确认已安装 Google Chrome。" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}
Write-Host "[OK] Chrome 路径: $chrome" -ForegroundColor Green

# 2. 检测调试端口是否已开
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:9222/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($resp.StatusCode -eq 200) {
        Write-Host "[INFO] 调试端口 9222 已经在工作，无需重启 Chrome。" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "下一步：在新 PowerShell 里跑  python -X utf8 -u cdp_listener.py" -ForegroundColor Cyan
        exit 0
    }
} catch {
    # 端口未开，继续
}

# 3. 提示用户保存 Chrome 内容，确认关闭
$running = (Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count
if ($running -gt 0) {
    Write-Host ""
    Write-Host "[WARN] 当前有 $running 个 Chrome 进程在跑。" -ForegroundColor Yellow
    Write-Host "       继续会强制关闭所有 Chrome（请先保存正在写的内容）。" -ForegroundColor Yellow
    $ans = Read-Host "继续？(y/N)"
    if ($ans -ne "y" -and $ans -ne "Y") {
        Write-Host "已取消。" -ForegroundColor Yellow
        exit 0
    }

    Write-Host "[STEP] 关闭所有 Chrome..."
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $still = (Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($still -gt 0) {
        Write-Host "[ERR] 还有 $still 个 Chrome 进程未关闭" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Chrome 已全部关闭" -ForegroundColor Green
}

# 4. 启动带调试端口的 Chrome（用 Default profile）
$profileDir = "$env:LOCALAPPDATA\Google\Chrome\User Data"
Write-Host "[STEP] 启动 Chrome（端口 9222, profile: Default）..."
Start-Process -FilePath $chrome -ArgumentList @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$profileDir",
    "--profile-directory=Default"
)

# 5. 等待 + 验证
Start-Sleep -Seconds 5
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:9222/json/version" -UseBasicParsing -TimeoutSec 5
    $json = $resp.Content | ConvertFrom-Json
    Write-Host "[OK] 调试端口在线: $($json.Browser)" -ForegroundColor Green
} catch {
    Write-Host "[ERR] 调试端口未启动: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Chrome 准备就绪。下一步：" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1) 在 Chrome 里登录 Shopee（首次需要）" -ForegroundColor White
Write-Host "  2) 在新 PowerShell 里跑监听器：" -ForegroundColor White
Write-Host "       python -X utf8 -u cdp_listener.py" -ForegroundColor Yellow
Write-Host "  3) 在 Chrome 里搜索/浏览 Shopee，监听器自动抓数据" -ForegroundColor White
Write-Host "  4) 抓完后跑解析器：" -ForegroundColor White
Write-Host "       python parser.py" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Cyan
