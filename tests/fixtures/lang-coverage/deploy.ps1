param(
    [string]$Environment = "staging",
    [switch]$DryRun
)

function Build-Project {
    Write-Host "Building project..."
    pnpm build
}

function Run-Tests {
    Write-Host "Running tests..."
    pnpm test
}

function Deploy-ToEnvironment {
    param([string]$Target)
    Write-Host "Deploying to $Target"
}

class DeployConfig {
    [string]$Environment
    [bool]$DryRun

    DeployConfig([string]$env, [bool]$dry) {
        $this.Environment = $env
        $this.DryRun = $dry
    }
}

Build-Project
Run-Tests
Deploy-ToEnvironment -Target $Environment
