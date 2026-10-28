# ============================================================
# All Craft Launcher 图标转换脚本（make-icon.ps1）
#
# 把源 PNG 图标（默认 build/icon-source.png）转换为：
#   build/icon.ico —— 多尺寸 Windows 图标（16/24/32/48/64/128/256，
#                     PNG 压缩条目，Vista+ 标准，electron-builder 打包用）
#   build/icon.png —— 256×256 PNG（README / 预览用）
#
# 用法（在项目根目录执行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1
#   或指定源图：  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1 -Source D:\path\to\icon.png
# ============================================================
param(
  # 源 PNG 图标路径；留空时使用 build/icon-source.png
  [string]$Source = "",
  # 输出目录（相对于项目根）
  [string]$OutDir = "build"
)

# 加载 Windows 绘图库
Add-Type -AssemblyName System.Drawing

# 输出目录（脚本位于 scripts/ 下，向上一级即项目根目录）
$projRoot = Split-Path $PSScriptRoot -Parent
$outPath = Join-Path $projRoot $OutDir
New-Item -ItemType Directory -Force -Path $outPath | Out-Null

# 源图解析
if (-not $Source) { $Source = Join-Path $outPath "icon-source.png" }
if (-not (Test-Path $Source)) { throw "源图标不存在：$Source" }
$src = [System.Drawing.Image]::FromFile($Source)
Write-Host ("源图标：{0}（{1}×{2}）" -f $Source, $src.Width, $src.Height)

# ICO 标准尺寸（256 为最大，Windows 自动选择合适档位渲染）
$sizes = 16, 24, 32, 48, 64, 128, 256

# ---------- 工具函数：把源图高质量缩放到指定尺寸，返回 PNG 字节数组 ----------
function Resize-PngBytes([int]$size) {
  # 创建带透明通道的目标位图
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # 高质量缩放（图标放大/缩小时边缘更平滑）
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  # 绘制到目标尺寸（DrawImage 自动等比缩放）
  $g.DrawImage($src, 0, 0, $size, $size)
  # 编码为 PNG 字节
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
  return ,$bytes   # 逗号防止 PowerShell 把字节数组展开
}

# ---------- 1. 逐尺寸缩放，缓存 PNG 字节 ----------
$entryBytes = @()
foreach ($s in $sizes) {
  $entryBytes += ,(Resize-PngBytes $s)
  Write-Host ("  已生成 {0}×{0}" -f $s)
}

# ---------- 2. 组装多尺寸 ICO 文件 ----------
# ICO 结构（参考 Windows ICO 格式规范）：
#   ICONDIR（6 字节头）+ N × ICONDIRENTRY（各 16 字节）+ 各图片数据。
#   条目尺寸字段为 0 表示 256；图片数据直接内嵌 PNG（Vista+ 支持）。
$icoPath = Join-Path $outPath "icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)                 # 保留字段
$bw.Write([uint16]1)                 # 类型：1 = 图标
$bw.Write([uint16]$sizes.Count)      # 条目数
$offset = 6 + 16 * $sizes.Count      # 首个图片数据的偏移
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $png = $entryBytes[$i]
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # 宽（0 = 256）
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # 高（0 = 256）
  $bw.Write([byte]0)                 # 调色板数（PNG 条目不用）
  $bw.Write([byte]0)                 # 保留
  $bw.Write([uint16]1)               # 色彩平面数
  $bw.Write([uint16]32)              # 位深
  $bw.Write([uint32]$png.Length)     # 数据长度
  $bw.Write([uint32]$offset)         # 数据偏移
  $offset += $png.Length
}
foreach ($png in $entryBytes) { $bw.Write($png) }   # 写入各图片数据
$bw.Flush(); $bw.Close(); $fs.Close()
Write-Host "已生成 ICO: $icoPath"

# ---------- 3. 输出 256 PNG（README / electron-builder 备用） ----------
$png256 = Resize-PngBytes 256
[System.IO.File]::WriteAllBytes((Join-Path $outPath "icon.png"), $png256)
Write-Host "已生成 PNG: $(Join-Path $outPath 'icon.png')"

# ---------- 4. 源图入库（保持图标来源可追溯、可再生成） ----------
$srcDest = Join-Path $outPath "icon-source.png"
$srcFull = (Resolve-Path $Source).Path
$dstFull = $null
try { $dstFull = (Resolve-Path $srcDest).Path } catch { }
if ($srcFull -ne $dstFull) {
  Copy-Item $Source $srcDest -Force
  Write-Host "源图已入库: $srcDest"
}

$src.Dispose()
Write-Host "图标转换完成。"
