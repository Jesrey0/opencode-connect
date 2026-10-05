# Windows Computer Use HostPlane (OpenCode Connect 0.7.0)

OpenCode Connect exposes four Windows Computer Use (WCU) v1 tools through the existing MCP transport and authorization boundary. WCU 0.4.0 remains on Windows `127.0.0.1:17842`; the adapter does not change its listener, configuration or authentication. Linux loopback is not used to contact WCU.

## Runtime and credentials

A `ComputerBackend` is created once by the HTTP handler and shared by all MCP exchanges. Its Windows PowerShell 7 child starts on the first computer request and persists until bridge failure or handler shutdown. The server supplies one explicit backend instance. Creating/listing tools does not start PowerShell or contact Windows.

The default executable is `/mnt/c/Program Files/PowerShell/7/pwsh.exe`. Set `OPENCODE_COMPUTER_PWSH` to override the executable path. This is an executable path, not a shell command. The child runs without profiles, interactively supplied commands, proxies or redirects. One .NET `HttpClient` serves all requests against the fixed Windows loopback origin.

Only the Windows child reads `%LOCALAPPDATA%\WindowsComputerUse\data\token.dpapi` and decrypts it with DPAPI `CurrentUser`. It converts the decrypted bytes to the WCU bearer token and sets the authorization header inside that process. It never creates/replaces the token file or returns the token to WSL. It requires the same Windows account and interactive desktop context as the WCU installation. Stderr is drained and discarded without retention or logging; replies and errors exclude credentials, HTTP headers and raw exception bodies. A successful JSON response containing the bearer token is rejected inside Windows before stdout.

## Tool contracts

All inputs are strict objects: extra fields are rejected. `handle` is a nonzero hexadecimal WCU handle in the signed 64-bit range, with an optional `0x` prefix. A locator contains at least one of `automationId`, `name`, `controlType`, each a nonblank string of at most 256 UTF-16 units. An optional `ancestor` uses the same criteria and cannot have another ancestor. Criteria are exact and case-sensitive; the adapter preserves text without trimming or case conversion. There is no fuzzy matching or locator cache. Bounded HostPlane waits are available only in [`computer.sequence`](computer-throughput.md).

### `computer.observe`

Read-only variants, selected by `type`:

| Input | WCU request | Structured result |
| --- | --- | --- |
| `{type:"capabilities"}` | `GET /v1/capabilities` | `{type, data: capabilities}` |
| `{type:"windows"}` | `GET /v1/windows` | `{type, data: windows[]}` |
| `{type:"state", handle}` | `GET /v1/windows/{handle}/state` | `{type, data: windowState}` |
| `{type:"find", handle, locator, maxResults?, maxNodes?, maxDepth?}` | `POST /v1/elements/find` | `{type, data: findResult}` |
| `{type:"inspect", handle, locator}` | `POST /v1/elements/inspect` | `{type, data: elementState}` |

`find` limits are `maxResults` 1..100, `maxNodes` 1..2000, and `maxDepth` 0..20. Omitted limits use WCU defaults. Discovery includes those limits and the discriminated variants. WCU's `complete`, `visitedNodes` and `locatorUnique` are preserved; a returned locator is not a cached identity or a future uniqueness guarantee.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`.

### `computer.interact`

Variants, selected by `action`:

| Input | Primary WCU request |
| --- | --- |
| `{action:"activate", handle}` | `POST /v1/windows/{handle}/activate` |
| `{action:"focus", handle, locator, activate?, readback?}` | `POST /v1/elements/focus` |
| `{action:"setValue", handle, locator, value, activate?, readback?}` | `POST /v1/actions/set-value-located` |
| `{action:"invoke", handle, locator, activate?, readback?}` | `POST /v1/actions/invoke-located` |
| `{action:"keySequence", chords:[{key, modifiers?}], handle?, activate?}` | `POST /v1/input/key-sequence` |
| `{action:"move", x, y}` | `POST /v1/input/move` |
| `{action:"click", x, y, button:"left"\|"right", count:1\|2}` | `POST /v1/input/pointer-click` |
| `{action:"scroll", delta, x?, y?}` | `POST /v1/input/scroll` |
| `{action:"drag", points:[{x,y},...], durationMs?, stepsPerSegment?}` | `POST /v1/input/drag` |
| `{action:"close", handle}` | `POST /v1/windows/{handle}/close` |

`activate` defaults to `false`; foreground activation is always explicit. For `focus`, `setValue` and `invoke`, `activate=true` prepends window activation, and `readback` defaults to `true`, appending an immediate `POST /v1/elements/inspect` with the same handle and locator. Set `readback=false` to omit inspection. `keySequence` requires `handle` when `activate=true`, then activates before injection. A handle with `activate=false` does not redirect key injection to that window: WCU injects into the current foreground context. Activation returning `isForeground=false` fails visibly and stops subsequent steps.

The structured result is `{action, result, activation?, state?}`. `result` is WCU's action response, activation response, focused element state, or close response. `activation` is included when a composition explicitly activates; `state` is included when inspection succeeds. This is immediate observed element state, not proof of application effects, saved files or workflow completion. Window close preserves `requestPosted` and `disappeared`; posting close does not guarantee disappearance.

`value` is at most 4096 UTF-16 units. Key sequences contain 1..32 chords; `key` is a numeric Windows virtual-key code 1..254. Optional `modifiers` are up to three unique codes: Shift=16, Ctrl=17, Alt=18. A modifier cannot equal the chord key. Omitted modifiers become an empty array because WCU requires an array. Coordinates are signed 32-bit integers and may be negative on multi-monitor desktops. Scroll `delta` is a nonzero integer in -1200..1200; provide both `x` and `y`, or neither.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=false`, `openWorldHint=true`.

Drag points contain 2..128 signed 32-bit coordinate pairs. `durationMs` is an integer in 0..5000. Optional `stepsPerSegment` is positive and must satisfy `1 + (points.length - 1) * stepsPerSegment <= 512`. Omitted fields are passed through as omitted so WCU chooses its defaults. Drag returns `{action:"drag", result:{success:true, metadata:{elapsedMs, emittedInputCount, steps}}}`; WCU timing and counts are preserved. No raw button-down/up action is exposed. Capabilities preserve WCU's `maxDragPoints`, `maxDragDurationMs` and `maxDragSteps` limits when advertised.

### `computer.sequence`

See [Computer Use Throughput](computer-throughput.md) for the 1..32-step batching contract, exact waits, HostPlane telemetry and failure results. Sequence uses the same action executor as `computer.interact`, is sequential, and stops on the first failure without replaying mutations. Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=false`, `openWorldHint=false`.

### `computer.screenshot`

Input: `{handle?}`. With a handle, requests `GET /v1/windows/{handle}/screenshot`; without one, requests `GET /v1/desktop/screenshot`. It never activates a window.

Success returns structured `{target:"desktop"|"window", handle?, mimeType:"image/png", size, width, height}` and exactly one MCP image content block. `size` counts decoded PNG bytes. Dimensions come from the PNG IHDR header, not arbitrary response headers. Base64 appears only in the image block. PNGs larger than 1 MiB fail visibly without truncation or resizing. The bridge checks the response media type; the backend checks the PNG signature and IHDR header. This is not a full PNG decoder.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`.

## Bridge protocol, concurrency and failure

WSL sends compact UTF-8 NDJSON over stdin: `{id:"wcu-N", steps:[{method:"GET"|"POST", path, body?}]}`. Only adapter-selected paths are accepted in Windows. One action composition contains 1..3 HTTP steps. A sequence issues one such transaction per action, or a single observation per wait poll. The child processes each request's steps sequentially before reading the next request, so concurrent MCP calls cannot interleave activation, injection and readback. The shared HostPlane backend also serializes entire sequences, including waits, with its other computer tool calls. Each request ID correlates with one reply:

- Success: `{id, ok:true, results:[...]}`. JSON steps return native JSON; screenshot steps return `{png:base64}` internally.
- Failure: `{id, ok:false, code, completedSteps, status?}`. Codes are fixed adapter categories; HTTP bodies and exception text are omitted. For a 404 from `/v1/elements/inspect` only, the bridge reads a bounded problem response and exports just the exact allowlisted code `element_not_found` or `locator_not_found`, enabling HostPlane absence waits. All other errors remain failures. A failed request stops its remaining steps.

The bridge admits at most 64 pending calls, with 64 KiB request frames. Each Windows transaction has a 10-second cancellation deadline covering all HTTP steps and bounded streaming reads. WSL gives each request 15 seconds, including process startup and queue time. JSON HTTP bodies are capped at 256 KiB; PNG bodies at 1 MiB; stdout frames at 2 MiB. The existing 256 KiB MCP structured-result limit also applies.

Malformed replies, correlation failures, I/O failure, process exit or the WSL deadline kill/reset the child and reject every pending call. The next new request starts another child lazily. There is no automatic replay, especially for mutations. Bounded HTTP/Windows errors reject only that call and keep the process usable. A timeout or failed readback can occur after an action took effect; inspect persisted/observed state before deciding to retry. `completedSteps` identifies acknowledged HTTP steps, not verified app effects or proof that a failed step never executed. DPAPI initialization failures export only a fixed failure; fixing the Windows account/token/path does not require changing MCP auth.

`createHttpHandler(backend, host, events?, computer?)` owns its backend lifecycle and closes it with the handler. `createServer(backend, host, events?, computer?)` accepts a shared backend without disposing it on individual MCP exchange closure. A standalone server closes its default backend with the connection. Direct callers own and close any shared backend they supply.

## Validation

`test/computer.test.ts` uses fake child streams and fake WCU transport data. It covers lazy persistence, correlation, UTF-8 framing, timeout, restart, safe errors, bounds, schemas/discovery, endpoint mapping, composition, screenshots and HTTP exchange lifetime. It also covers drag passthrough, sequence validation/order/failures, exact wait polling/deadlines, timing and sequence discovery. Normal `npm test` does not require Windows, WCU, PowerShell or token access. Live Windows desktop/DPAPI integration must be validated separately before deployment; this worktree does not deploy or restart services.
