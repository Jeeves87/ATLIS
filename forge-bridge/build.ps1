# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.
# Compile the ATLIS ⇄ Forge bridge against an installed Forge's desktop jar.
#   powershell -File build.ps1 [-Forge C:\Forge]
# Output: build\atlis-forge-bridge.jar
param([string]$Forge = "C:\Forge")
$ErrorActionPreference = "Stop"

$jdk = Get-ChildItem "C:\Program Files\Eclipse Adoptium\jdk-*\bin\javac.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $jdk) { throw "No JDK found under C:\Program Files\Eclipse Adoptium (install a Temurin 17+ JDK)." }
$bin = Split-Path $jdk.FullName

$jar = Get-ChildItem $Forge -Filter "forge-gui-desktop-*-jar-with-dependencies.jar" | Select-Object -First 1
if (-not $jar) { throw "No forge-gui-desktop jar in $Forge." }

Set-Location $PSScriptRoot
Remove-Item -Recurse -Force build\classes -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force build\classes | Out-Null
$src = Get-ChildItem -Recurse src -Filter *.java | ForEach-Object { $_.FullName }
# javac/jar report on stderr; Windows PowerShell treats that as a terminating
# error under "Stop", so judge them by exit code instead.
$ErrorActionPreference = "Continue"
& "$bin\javac.exe" -encoding UTF-8 -Xlint:-options --release 17 -cp $jar.FullName -d build\classes $src
if ($LASTEXITCODE -ne 0) { throw "javac failed" }
# A running game keeps its jar open (Windows won't overwrite it), so each build
# gets a fresh timestamped name; ATLIS starts new games with the newest one.
$name = "atlis-forge-bridge-$(Get-Date -Format yyyyMMddHHmmss).jar"
& "$bin\jar.exe" --create --file "build\$name" -C build\classes .
if ($LASTEXITCODE -ne 0) { throw "jar failed" }
# Old builds go once nothing has them open; a locked one is in use by a game.
Get-ChildItem build -Filter "atlis-forge-bridge*.jar" | Where-Object { $_.Name -ne $name } |
  ForEach-Object { try { Remove-Item $_.FullName -ErrorAction Stop } catch { } }
"Built build\$name against $($jar.Name)"
