param([string]$Initial = '')

# Native folder chooser for dsh-project-sources.
#
# Runs on an STA thread (powershell -STA): FolderBrowserDialog needs one.
# Protocol for the Host half:
#   exit 0 + a path on stdout  -> the operator picked that folder
#   exit 0 + empty stdout      -> the operator cancelled
#   exit 1 + a message on stderr -> the dialog could not be shown
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '选择一个文件夹作为项目源'
  $dialog.ShowNewFolderButton = $true
  $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer

  if ($Initial -ne '' -and (Test-Path -LiteralPath $Initial)) {
    try { $dialog.SelectedPath = (Resolve-Path -LiteralPath $Initial).Path } catch { }
  }

  $result = $dialog.ShowDialog()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}