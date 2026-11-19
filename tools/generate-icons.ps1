# Generates PNG app icons without external dependencies.
# Usage: powershell -ExecutionPolicy Bypass -File tools/generate-icons.ps1
# Output: icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
# NOTE: keep this file ASCII-only, Windows PowerShell 5.1 reads .ps1 as ANSI.

Add-Type -AssemblyName System.Drawing

function New-AppIcon {
    param(
        [int]$Size,
        [string]$Path,
        [switch]$Maskable
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 96, 165, 250),
        [System.Drawing.Color]::FromArgb(255, 37, 99, 235),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)

    $scale = 1.0

    if ($Maskable) {
        # Maskable icon: full-bleed background, logo inside the safe zone.
        $graphics.FillRectangle($brush, $rect)
        $scale = 0.82
    } else {
        $radius = [int]($Size * 0.226)
        $diameter = $radius * 2
        $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
        $shape.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $shape.AddArc($Size - $diameter, 0, $diameter, $diameter, 270, 90)
        $shape.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0, 90)
        $shape.AddArc(0, $Size - $diameter, $diameter, $diameter, 90, 90)
        $shape.CloseFigure()
        $graphics.FillPath($brush, $shape)
        $shape.Dispose()
    }

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($Size * 0.088))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $points = @(
        @(0.29, 0.52),
        @(0.43, 0.665),
        @(0.715, 0.345)
    )

    $pointsF = New-Object 'System.Drawing.PointF[]' $points.Count
    for ($i = 0; $i -lt $points.Count; $i++) {
        $fx = 0.5 + ($points[$i][0] - 0.5) * $scale
        $fy = 0.5 + ($points[$i][1] - 0.5) * $scale
        $pointsF[$i] = New-Object System.Drawing.PointF([single]($fx * $Size), [single]($fy * $Size))
    }

    $graphics.DrawLines($pen, $pointsF)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    $pen.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root 'icons'
if (-not (Test-Path $icons)) { New-Item -ItemType Directory -Path $icons | Out-Null }

New-AppIcon -Size 192 -Path (Join-Path $icons 'icon-192.png')
New-AppIcon -Size 512 -Path (Join-Path $icons 'icon-512.png')
New-AppIcon -Size 512 -Path (Join-Path $icons 'icon-maskable-512.png') -Maskable
New-AppIcon -Size 180 -Path (Join-Path $icons 'apple-touch-icon.png') -Maskable

Write-Host 'Icons generated:'
Get-ChildItem $icons -Filter *.png | ForEach-Object { Write-Host ("  " + $_.Name + "  " + $_.Length + " bytes") }
