# ============================================================
# All Craft Launcher 图标生成脚本（原创图标，纯代码绘制，无外部素材）
#
# 依赖 Windows 自带 .NET System.Drawing，输出：
#   build/icon.png —— 256×256 PNG（README / 预览用）
#   build/icon.ico —— Windows 图标（electron-builder 打包用）
#
# 用法（在项目根目录执行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1
# ============================================================
param([string]$OutDir = "build")

# 加载 Windows 绘图库
Add-Type -AssemblyName System.Drawing

# 输出目录（脚本位于 scripts/ 下，向上一级即项目根目录）
$projRoot = Split-Path $PSScriptRoot -Parent
$outPath = Join-Path $projRoot $OutDir
New-Item -ItemType Directory -Force -Path $outPath | Out-Null

# ---------- 1. 创建 256×256 透明画布并开启抗锯齿 ----------
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# ---------- 2. 圆角矩形路径工具函数 ----------
# 用于绘制背景圆角方块与色块（GraphicsPath 手工拼接四段圆弧）
function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)                  # 左上角
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)        # 右上角
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)   # 右下角
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)         # 左下角
  $p.CloseFigure()
  return $p
}

# ---------- 3. 背景：深蓝灰渐变圆角方块（呼应启动器深色主题） ----------
$bgPath = New-RoundedRectPath 8 8 240 240 56
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.RectangleF(8, 8, 240, 240)),
  [System.Drawing.Color]::FromArgb(255, 42, 53, 71),   # 顶部：深蓝灰
  [System.Drawing.Color]::FromArgb(255, 26, 33, 45),   # 底部：更深
  90)
$g.FillPath($bgBrush, $bgPath)

# ---------- 4. 中央字母 “A”（All Craft Launcher 首字母） ----------
$font = New-Object System.Drawing.Font("Arial Black", 132, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(28, 34, 200, 160)

# 字母用竖向渐变填充（亮白 → 灰蓝）
$textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$textPath.AddString("A", $font.FontFamily, [int][System.Drawing.FontStyle]::Bold, 132, $textRect, $sf)
$textBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.RectangleF(28, 34, 200, 160)),
  [System.Drawing.Color]::FromArgb(255, 234, 241, 251),
  [System.Drawing.Color]::FromArgb(255, 160, 178, 205),
  90)
$g.FillPath($textBrush, $textPath)

# ---------- 5. 橙色下划线色块（启动器强调色） ----------
$linePath = New-RoundedRectPath 78 198 100 14 7
$orangeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 159, 67))
$g.FillPath($orangeBrush, $linePath)

# ---------- 6. 右上角像素风「草方块」点缀（绿色顶 + 泥土底，MC 色系彩蛋） ----------
$greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 88, 200, 120))
$dirtBrush  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 134, 96, 67))
$g.FillRectangle($greenBrush, 190, 42, 22, 22)   # 草皮
$g.FillRectangle($dirtBrush, 190, 64, 22, 12)    # 泥土

# ---------- 7. 保存 PNG ----------
$pngPath = Join-Path $outPath "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "已生成 PNG: $pngPath"

# ---------- 8. 保存 ICO（经 GDI HICON 句柄转换） ----------
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$icoPath = Join-Path $outPath "icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
Write-Host "已生成 ICO: $icoPath"

# ---------- 9. 释放 GDI 资源 ----------
$g.Dispose()
$bmp.Dispose()
Write-Host "图标生成完成。"
