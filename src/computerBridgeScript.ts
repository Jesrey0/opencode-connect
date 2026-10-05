// Static source only: tool input is sent as NDJSON, never inserted into PowerShell.
// EncodedCommand avoids WSL/Windows path translation and shell quoting entirely.
export const WINDOWS_COMPUTER_BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $tokenPath = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'WindowsComputerUse', 'data', 'token.dpapi')
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($tokenPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $token = [Convert]::ToBase64String($plain)
  [Array]::Clear($plain, 0, $plain.Length)
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.BaseAddress = [Uri]::new('http://127.0.0.1:17842')
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
} catch {
  [Console]::Error.WriteLine('Computer bridge initialization failed; details omitted')
  exit 1
}
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $id = $null
    $completed = 0
    $code = 'bridge'
    $status = $null
    $cts = $null
    try {
      if ($line.Length -gt 65536) { throw 'invalid' }
      $request = ConvertFrom-Json -InputObject $line -AsHashtable -NoEnumerate -Depth 64
      $id = $request.id
      if ($id -isnot [string] -or $id -notmatch '^wcu-[0-9]+$' -or $request.steps.Count -lt 1 -or $request.steps.Count -gt 3) { throw 'invalid' }
      $cts = [Threading.CancellationTokenSource]::new(10000)
      $results = [Collections.Generic.List[object]]::new()
      foreach ($step in $request.steps) {
        $message = $null
        $response = $null
        $stream = $null
        $memory = $null
        try {
          $path = [string]$step.path
          $validGet = $path -match '^/v1/(capabilities|windows|desktop/screenshot|windows/(?:0[xX])?[0-9a-fA-F]{1,16}/(state|screenshot))$'
          $validPost = $path -match '^/v1/(windows/(?:0[xX])?[0-9a-fA-F]{1,16}/(activate|close)|elements/(find|inspect|focus)|actions/(invoke-located|set-value-located)|input/(key-sequence|move|pointer-click|scroll|drag))$'
          if (!(($step.method -ceq 'GET' -and $validGet) -or ($step.method -ceq 'POST' -and $validPost))) { throw 'invalid' }
          $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($step.method), $path)
          if ($null -ne $step.body) {
            $body = ConvertTo-Json -InputObject $step.body -Compress -Depth 64
            $message.Content = [Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json')
          }
          $code = 'transport'
          $response = $client.SendAsync($message, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token).GetAwaiter().GetResult()
          if (!$response.IsSuccessStatusCode) {
            $code = 'http'
            $status = [int]$response.StatusCode
            # Only an exact, bounded absence code from inspect crosses this boundary.
            # Never export upstream titles, details, exception text or credentials.
            if ($status -eq 404 -and $path -ceq '/v1/elements/inspect') {
              $stream = $response.Content.ReadAsStreamAsync($cts.Token).GetAwaiter().GetResult()
              $memory = [IO.MemoryStream]::new()
              $buffer = [byte[]]::new(8192)
              while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $cts.Token).GetAwaiter().GetResult()) -gt 0) {
                if ($memory.Length + $count -gt 262144) { $code = 'too_large'; throw 'size' }
                $memory.Write($buffer, 0, $count)
              }
              try {
                $problem = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($memory.ToArray())) -AsHashtable -NoEnumerate -Depth 64
                if ($problem.code -ceq 'element_not_found') { $code = 'element_not_found' }
                if ($problem.code -ceq 'locator_not_found') { $code = 'locator_not_found' }
              } catch { $code = 'http' }
            }
            throw 'http'
          }
          $isPng = $path.EndsWith('/screenshot', [StringComparison]::Ordinal)
          $limit = if ($isPng) { 1048576 } else { 262144 }
          if ($response.Content.Headers.ContentLength -gt $limit) { $code = 'too_large'; throw 'size' }
          $stream = $response.Content.ReadAsStreamAsync($cts.Token).GetAwaiter().GetResult()
          $memory = [IO.MemoryStream]::new()
          $buffer = [byte[]]::new(8192)
          while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $cts.Token).GetAwaiter().GetResult()) -gt 0) {
            if ($memory.Length + $count -gt $limit) { $code = 'too_large'; throw 'size' }
            $memory.Write($buffer, 0, $count)
          }
          if ($isPng) {
            $code = 'png'
            if ($response.Content.Headers.ContentType.MediaType -cne 'image/png') { throw 'png' }
            $data = @{ png = [Convert]::ToBase64String($memory.ToArray()) }
          } else {
            $code = 'invalid_json'
            $data = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($memory.ToArray())) -AsHashtable -NoEnumerate -Depth 64
          }
          # An explicit activation must succeed before injecting any following input.
          if ($path.EndsWith('/activate', [StringComparison]::Ordinal) -and $data.isForeground -ne $true) {
            $code = 'activation'
            throw 'activation'
          }
          $results.Add($data)
          $completed++
        } finally {
          if ($null -ne $stream) { $stream.Dispose() }
          if ($null -ne $memory) { $memory.Dispose() }
          if ($null -ne $response) { $response.Dispose() }
          if ($null -ne $message) { $message.Dispose() }
        }
      }
      $reply = @{ id = $id; ok = $true; results = $results.ToArray() }
      $encoded = ConvertTo-Json -InputObject $reply -Compress -Depth 64
      # Never allow the bearer token to cross stdout even if upstream data echoes it.
      if ($encoded.Contains($token, [StringComparison]::Ordinal)) { throw 'secret' }
      [Console]::Out.WriteLine($encoded)
    } catch {
      if ($null -ne $cts -and $cts.IsCancellationRequested) { $code = 'timeout' }
      if ($null -eq $id -or $id -isnot [string] -or $id -notmatch '^wcu-[0-9]+$') { exit 1 }
      $reply = @{ id = $id; ok = $false; code = $code; completedSteps = $completed }
      if ($null -ne $status) { $reply.status = $status }
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Compress))
    } finally {
      if ($null -ne $cts) { $cts.Dispose() }
    }
  }
} finally {
  $client.Dispose()
}
`;
