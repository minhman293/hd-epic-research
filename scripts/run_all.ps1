# run_all.ps1 - regenerate every output from the current code, then collect
# the figures into one file.
#
# WHY THIS RUNS FIRST
# ---------------------------------------------------------------------------
# The JSON files in the repo were built by an older configuration: SCOPE_MODE
# "window" instead of "span", and edge thinning still on. The code has moved
# and the data has not, which is why the write-up ended up quoting 26 states
# and 124 states for the same thing. Nothing else is trustworthy until every
# file comes from one run of one pipeline.
#
# WHY A .ps1 AS WELL AS A .sh
# ---------------------------------------------------------------------------
# `bash run_all.sh` started from PowerShell runs Git Bash or WSL, and neither
# inherits the active conda environment - so `python` is not on the PATH inside
# it. Run this from the same PowerShell window where (study) is active.
#
#   .\run_all.ps1
#   .\run_all.ps1 -Recipes P01_R01,P03_R03
#
# TWO POWERSHELL TRAPS THIS FILE AVOIDS
# ---------------------------------------------------------------------------
# 1. Never name a function parameter $Args. It is an automatic variable, so a
#    parameter of that name never receives the caller's value and the splat
#    `& $PY @Args` expands to nothing - which starts an interactive Python REPL
#    instead of running the script. That is a silent failure: python appears to
#    launch fine and simply waits at >>>.
# 2. `Write-Host "a" + ("-" * 10)` does not concatenate. In command mode the
#    `+` and the parenthesised string are passed as extra arguments and printed
#    literally. Build the string first, or use an expandable string.
#
# Run from the directory that holds 6_prepare_dashboard_data.py.

param(
    [string[]]$Recipes = @("P01_R01", "P03_R03", "P05_R02"),
    [string]$Outputs   = "../outputs",
    [string]$Narr      = "../narrations-and-action-segments"
)

$ErrorActionPreference = "Stop"

# Use the interpreter that belongs to this shell's active environment.
$PY = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $PY) { $PY = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $PY) {
    Write-Host "No python found on PATH. Activate the environment first:" -ForegroundColor Red
    Write-Host "    conda activate study"
    exit 1
}
Write-Host "python: $PY"
& $PY --version

$Rule = "-" * 46

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host ""
    Write-Host "---- $Label $Rule"

    # Guard against the failure that produced the REPL: if the argument list
    # is empty, python would open interactively and the run would hang with no
    # error message at all.
    if ($Arguments.Count -eq 0) {
        Write-Host "Refusing to call python with no arguments ($Label)." -ForegroundColor Red
        exit 1
    }

    & $PY @Arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $Label (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "=============================================================="
Write-Host "REGENERATING: $($Recipes -join ', ')"
Write-Host "scope=span   thinning=off   (current defaults)"
Write-Host "=============================================================="

foreach ($R in $Recipes) {
    Invoke-Step -Label "$R : 6_prepare_dashboard_data" -Arguments @(
        "6_prepare_dashboard_data.py", $R, "--outputs-dir", $Outputs, "--scope", "span")

    Invoke-Step -Label "$R : 8_aggregate_sessions" -Arguments @(
        "8_aggregate_sessions.py", $R, "--outputs-dir", $Outputs)

    # No --thin-edges. Every observed transition is drawn.
    Invoke-Step -Label "$R : 9_build_episode_graphs" -Arguments @(
        "9_build_episode_graphs.py", $R,
        "--graphs-dir", "$Outputs/graphs", "--narrations-dir", $Narr)
}

if (Test-Path "7_build_manifest.py") {
    Invoke-Step -Label "manifest" -Arguments @("7_build_manifest.py")
} else {
    Write-Host ""
    Write-Host "  (7_build_manifest.py not found - skipped)"
}

Invoke-Step -Label "figures" -Arguments (
    @("collect_figures.py") + $Recipes +
    @("--graphs-dir", "$Outputs/graphs", "--out-dir", $Outputs))

Write-Host ""
Write-Host "=============================================================="
Write-Host "Done. Read $Outputs/figures.md."
Write-Host "Every number in explained_pipeline.md must now be copied from"
Write-Host "that file. If it has warnings, fix those before writing anything."
Write-Host "=============================================================="