param(
    [string]$Destination = (Join-Path (Get-Location) 'lightning-pay-fixed.zip')
)

$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$sourcePath = [System.IO.Path]::GetFullPath((Get-Location).Path)
if (-not $destinationPath.EndsWith('.zip', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Destination must be a .zip file.'
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $destinationPath))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
}

$requiredDeploymentFiles = @(
    'server.js',
    'package.json',
    'database/mysql.js',
    'database/sqlite.js',
    'routes/pay.js',
    'routes/links.js',
    'public/app.html',
    'public/js/app.js',
    'public/css/panel-mobile.css',
    'public/css/reseller-mobile.css',
    'public/js/reseller-enhancements.js',
    'public/img/cashapp-social-card.png'
)
$missingDeploymentFiles = $requiredDeploymentFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $sourcePath $_) -PathType Leaf)
}
if ($missingDeploymentFiles) {
    throw "Deployment aborted. Required files are missing: $($missingDeploymentFiles -join ', ')"
}

$excluded = @(
    '.git', '.github', '.vscode', '.system_generated', '.npm-cache', 'node_modules',
    'data', 'tmp', 'coverage', 'tests', 'scripts', '.env', 'deploy.zip',
    'SESSION_STATE.md', 'STABILITY_REPORT.md'
)
$items = Get-ChildItem -Force -LiteralPath $sourcePath | Where-Object {
    $_.Name -notin $excluded -and $_.Extension -ne '.zip'
}
if (-not $items) { throw 'No deployment files were found.' }

Compress-Archive -LiteralPath $items.FullName -DestinationPath $destinationPath -Force -ErrorAction Stop
if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
    throw 'Deployment archive was not created.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($destinationPath)
try {
    $archiveEntries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $missingArchiveFiles = $requiredDeploymentFiles | Where-Object {
        $archiveEntries -notcontains $_.Replace('\', '/')
    }
    if ($missingArchiveFiles) {
        throw "Deployment archive verification failed. Missing entries: $($missingArchiveFiles -join ', ')"
    }
} finally {
    if ($archive) { $archive.Dispose() }
}
Write-Output "DEPLOY_ZIP_CREATED_SUCCESSFULLY: $destinationPath"
