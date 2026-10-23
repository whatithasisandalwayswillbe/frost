# Installs the latest Frost release on Windows.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
#
# This script:
# - Downloads the appropriate package for your processor architecture.
# - Verifies that 'checksums.txt' is signed by the official Frost release key.
# - Validates the download against the verified checksum.
# - Installs the launcher and its bundled runtime.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $Repo = 'whatithasisandalwayswillbe/frost'

  # Public key
  $ReleaseKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHO/g64dTbRW3poi7pdiPKgljYdHXG+TZeZQg4cfzAsV'

  $Verifier = @'
'use strict';
const { readFileSync } = require('node:fs');
const { createHash, createPublicKey, verify, timingSafeEqual } = require('node:crypto');

const [authorized, sumsFile, signatureFile] = process.argv.slice(2);

// Reads SSH wire format: big-endian uint32s and uint32-length-prefixed strings. Any overrun throws.
function wire(buffer) {
  let pos = 0;
  const uint32 = () => {
    if (pos + 4 > buffer.length) throw new Error('truncated');
    const n = buffer.readUInt32BE(pos);
    pos += 4;
    return n;
  };
  return {
    uint32,
    string() {
      const n = uint32();
      if (n > buffer.length - pos) throw new Error('truncated');
      const b = buffer.subarray(pos, pos + n);
      pos += n;
      return b;
    },
    end() {
      if (pos !== buffer.length) throw new Error('trailing bytes');
    },
  };
}

function sshString(value) {
  const b = Buffer.from(value);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(b.length);
  return Buffer.concat([n, b]);
}

try {
  // The key line is "ssh-ed25519 <base64>", wrapping the key type and 32 key bytes.
  const fields = authorized.trim().split(/\s+/);
  if (fields[0] !== 'ssh-ed25519' || !fields[1]) throw new Error('release key must be ed25519');
  const want = Buffer.from(fields[1], 'base64');
  const keyReader = wire(want);
  if (keyReader.string().toString() !== 'ssh-ed25519') throw new Error('bad key');
  const publicKey = keyReader.string();
  keyReader.end();
  if (publicKey.length !== 32) throw new Error('bad key');

  // The armor body must be canonical base64 that round-trips exactly, starting with "SSHSIG".
  const armor = readFileSync(signatureFile, 'utf8').replaceAll('\r\n', '\n').trim();
  const match = /^-----BEGIN SSH SIGNATURE-----\s+([A-Za-z0-9+/=\s]+)\s+-----END SSH SIGNATURE-----$/.exec(armor);
  if (!match) throw new Error('bad armor');
  const encoded = match[1].replace(/\s/g, '');
  const blob = Buffer.from(encoded, 'base64');
  if (blob.toString('base64') !== encoded || blob.subarray(0, 6).toString() !== 'SSHSIG') throw new Error('bad armor');

  // Version 1, then the signer's public key, namespace, reserved, hash algorithm and signature. The signer must be
  // the release key, the namespace "file" and the hash SHA-256 or SHA-512.
  const reader = wire(blob.subarray(6));
  if (reader.uint32() !== 1) throw new Error('bad version');
  const actual = reader.string();
  const namespace = reader.string();
  const reserved = reader.string();
  const hashAlg = reader.string();
  const sig = reader.string();
  reader.end();
  if (actual.length !== want.length || !timingSafeEqual(actual, want) || namespace.toString() !== 'file')
    throw new Error('wrong signer');
  if (!['sha256', 'sha512'].includes(hashAlg.toString())) throw new Error('bad hash');

  // The signature blob is the key type and a 64-byte Ed25519 signature.
  const inner = wire(sig);
  if (inner.string().toString() !== 'ssh-ed25519') throw new Error('bad signature');
  const signature = inner.string();
  inner.end();
  if (signature.length !== 64) throw new Error('bad signature');

  // The signed data is "SSHSIG", then namespace, reserved, hash algorithm and the message hash as SSH strings. The
  // DER prefix wraps the raw key as an Ed25519 SubjectPublicKeyInfo.
  const digest = createHash(hashAlg.toString()).update(readFileSync(sumsFile)).digest();
  const signed = Buffer.concat([Buffer.from('SSHSIG'), ...[namespace, reserved, hashAlg, digest].map(sshString)]);
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
    type: 'spki',
    format: 'der',
  });
  if (!verify(null, signed, key, signature)) throw new Error('bad signature');
  console.log('ok');
} catch {
  process.exitCode = 1;
}
'@

  # Downloads with up to three attempts, like install.sh's curl --retry 3.
  function Save-Download([string]$Url, [string]$Destination) {
    for ($attempt = 1; ; $attempt++) {
      try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
        return
      } catch {
        if ($attempt -ge 3) { throw "download failed: $Url" }
        Start-Sleep -Seconds $attempt
      }
    }
  }

  function Get-LatestVersion {
    try {
      $request = [Net.WebRequest]::Create("https://github.com/$Repo/releases/latest")
      $request.Method = 'HEAD'
      $response = $request.GetResponse()
      try { $path = $response.ResponseUri.AbsolutePath } finally { $response.Close() }
      $tag = $path.Substring($path.LastIndexOf('/') + 1)
    } catch {
      $tag = ''
    }
    if (-not $tag.StartsWith('v')) { throw "could not determine latest release version (set FROST_VERSION environment variable to select manually)" }
    $tag
  }

  # Compares PATH entries the way Windows reads them: expanded, case-insensitive, without a trailing backslash.
  function Test-OnPath([string]$Value, [string]$Folder) {
    $want = $Folder.TrimEnd('\')
    foreach ($entry in $Value -split ';') {
      if ($entry -and [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -eq $want) { return $true }
    }
    $false
  }
  function Invoke-Runtime([string]$Node, [string[]]$Arguments) {
    $options = $env:NODE_OPTIONS
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    try {
      & $Node @Arguments
    } finally {
      if ($null -ne $options) { $env:NODE_OPTIONS = $options }
    }
  }

  $tmp = $null
  try {
    if ($env:OS -ne 'Windows_NT') { throw 'install.ps1 is target-specific to Windows. Use install.sh on macOS or Linux environments' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $processor = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
    switch ($processor) {
      'AMD64' { $arch = 'amd64' }
      'ARM64' { $arch = 'arm64' }
      default { throw "unsupported CPU architecture: $processor" }
    }

    $version = $env:FROST_VERSION
    if (-not $version) { $version = Get-LatestVersion }
    if (-not ($version -cmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$') -or $version -match '\s') {
      throw 'invalid release version'
    }
    $num = $version.Substring(1)
    $archive = "frost_${num}_windows_${arch}.zip"
    $base = $env:FROST_BASE_URL
    if (-not $base) { $base = "https://github.com/$Repo/releases/download/$version" }

    # Download and verify.
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('frost-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp $archive
    $sums = Join-Path $tmp 'checksums.txt'
    $signature = Join-Path $tmp 'checksums.txt.sig'

    Write-Host "Downloading Frost $version for windows/$arch"
    Save-Download "$base/$archive" $zip
    Save-Download "$base/checksums.txt" $sums
    Save-Download "$base/checksums.txt.sig" $signature

    $found = @(Get-Content -LiteralPath $sums | ForEach-Object {
        $fields = -split $_
        if ($fields.Count -ge 2 -and ($fields[1] -ceq $archive -or $fields[1] -ceq "*$archive")) { $fields[0] }
      })
    if ($found.Count -ne 1) { throw "$archive needs one entry in checksums.txt" }
    $want = $found[0]
    if ($want -notmatch '\A[0-9a-fA-F]{64}\z') { throw "invalid SHA-256 checksum for $archive" }
    $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($want -ne $got) { throw "checksum mismatch for $archive (expected $want, got $got)" }

    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $check = Join-Path $tmp 'check'
    New-Item -ItemType Directory -Path $check | Out-Null
    $checkNode = Join-Path $check 'node.exe'
    $reader = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
      $runtime = @($reader.Entries | Where-Object { $_.FullName -ceq 'runtime/bin/node.exe' })
      if ($runtime.Count -ne 1) { throw "runtime not found in $archive" }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($runtime[0], $checkNode)
    } finally {
      $reader.Dispose()
    }
    $authenticode = Get-AuthenticodeSignature -LiteralPath $checkNode
    $signer = $authenticode.SignerCertificate
    if (
      $authenticode.Status -ne 'Valid' -or -not $signer -or
      $signer.GetNameInfo('SimpleName', $false) -cne 'OpenJS Foundation' -or
      $signer.Subject -cnotmatch '(^|, )O=OpenJS Foundation(,|$)'
    ) {
      throw "runtime inside $archive lacks valid OpenJS Foundation signature; installation aborted"
    }
    $verify = Join-Path $check 'verify.cjs'
    [IO.File]::WriteAllText($verify, $Verifier)
    $result = Invoke-Runtime $checkNode @($verify, $ReleaseKey, $sums, $signature)
    if ($LASTEXITCODE -ne 0 -or "$result" -cne 'ok') {
      throw "checksums.txt signature does not match official Frost release key; installation aborted"
    }
    Write-Host 'Signature ok'
    Write-Host 'Checksum ok'

    $package = Join-Path $tmp 'x'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $package)
    foreach ($required in @(
        @('manifest.json', "package manifest not found in $archive"),
        @('frost.cmd', "frost.cmd not found in $archive"),
        @('runtime\bin\node.exe', "runtime not found in $archive"),
        @('install.mjs', "package installer not found in $archive")
      )) {
      if (-not (Test-Path -LiteralPath (Join-Path $package $required[0]) -PathType Leaf)) { throw $required[1] }
    }

    $dir = $env:FROST_INSTALL_DIR
    $default = -not $dir
    if ($default) {
      $local = $env:LOCALAPPDATA
      if (-not $local) { $local = Join-Path $HOME 'AppData\Local' }
      $dir = Join-Path $local 'frost\bin'
    }
    $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dir)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    Invoke-Runtime (Join-Path $package 'runtime\bin\node.exe') @((Join-Path $package 'install.mjs'), $package, $dir) | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'package install failed' }

    if (-not (Test-OnPath $env:Path $dir)) {
      if ($default) {
        $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
          $userPath = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          $added = -not (Test-OnPath $userPath $dir)
          if ($added) {
            $value = if ($userPath) { $userPath.TrimEnd(';') + ';' + $dir } else { $dir }
            $environment.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
          }
        } finally {
          $environment.Dispose()
        }
        if ($added) {
          [Environment]::SetEnvironmentVariable('FROST_INSTALL_REFRESH', '1', 'User')
          [Environment]::SetEnvironmentVariable('FROST_INSTALL_REFRESH', $null, 'User')
          Write-Host ''
          Write-Host "Added $dir to your PATH. Restart existing terminals to use the updated PATH."
        }
        $env:Path = $dir + ';' + $env:Path
      } else {
        Write-Host ''
        Write-Host "$dir is not currently in PATH. Add it to your user Path environment variable."
      }
    }

    Write-Host ''
    Write-Host "Next: run 'frost init' to set up your first backup."
  } catch {
    $Host.UI.WriteErrorLine("install.ps1: $($_.Exception.Message)")
    if ($PSCommandPath) { exit 1 }
  } finally {
    if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
