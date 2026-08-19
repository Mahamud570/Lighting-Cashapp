$dest = 'C:\Users\User\Desktop\deploy.zip'
if (Test-Path $dest) {
    Remove-Item -Force $dest
}
$items = Get-ChildItem -Path . | Where-Object {
    $_.Name -notin @('.git', 'node_modules', '.vscode', '.system_generated', 'scratch', 'tests', '.github')
}
Compress-Archive -Path $items.FullName -DestinationPath $dest -Force
Write-Output "DEPLOY_ZIP_CREATED_SUCCESSFULLY"
