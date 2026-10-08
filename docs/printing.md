# Printing HostPlane (OpenCode Connect 0.7.0)

Printing is a generic **HostPlane** adapter, independent of BAR or any other
application. Nine `print.*` tools use the separate Windows Print Bridge CLI,
`print-bridge.exe`. They travel over the existing authenticated OpenCode Connect
MCP route (`/opencode-connect/mcp`); host-ingress does not expose a second
print route or manage the Windows printer.

## Deployment prerequisites and authority

- Install and configure Windows Print Bridge and the actual Windows printer
  separately. This repository does not install drivers, configure paper trays,
  discover loaded media with sensors, or administer the Windows desktop.
- For OpenCode Connect on **WSL/Linux**, set **server-side**
  `PRINT_BRIDGE_EXE` to a WSL-accessible path to `print-bridge.exe`.
  No valid Linux fallback is assumed. Native Windows processes may derive a
  default from `LOCALAPPDATA\WindowsPrintBridge\print-bridge.exe`.
  Tool callers cannot supply an arbitrary executable.
- First use `print.status` and `print.capabilities` to observe actual
  bridge/printer readiness. Source checks and MCP tool listing alone are not
  proof of a connected printer or successful physical printing.
- Print calls run with the host service's configured access to Windows; MCP
  callers inherit the trust of the authenticated single-user host. Do not
  forward these tools into a multi-tenant environment without a separate
  authorization boundary.

## Tool contracts

| Tool | Input | Effect |
| --- | --- | --- |
| `print.status` | `{}` | Read print-bridge status |
| `print.capabilities` | `{printer?}` | Read discovered printer features; optionally select a named printer |
| `print.media` | `{}` | Read the current **human-declared** loaded paper/media |
| `print.set_media` | `{paper, media?}` | Persist a human declaration of loaded paper and media; **does not load paper physically** |
| `print.inspect` | `{path, filename?}` | Validate and inspect an existing host file without printing |
| `print.submit` | `{path, filename?, printer?, copies?, paper?, orientation?, color?, scale?}` | Submit a real print job with physical paper side effects |
| `print.queue` | `{printer?}` | Read current queued jobs |
| `print.job` | `{printer, id}` | Inspect one printer job by its returned ID |
| `print.cancel` | `{printer, id}` | Ask Windows to cancel a job; already printed pages cannot be recalled |

The `path` for inspect/submit is an **existing absolute host path**,
canonicalized before use and restricted to a regular file no larger than
**25 MiB**. File contents stream as raw bytes into the bridge's stdin,
not as base64 in MCP tool arguments. An optional `filename` is a display name
without path separators. `copies` is an integer 1–99. `orientation` is
`Auto`, `Portrait`, or `Landscape`; `color` is `Auto`, `Color`, or
`Grayscale`; `scale` is `Fit` or `Actual`. Available paper names,
printers, and media types must come from bridge/printer capabilities or
explicit physical operator knowledge, not inference.

The bridge is **one short-lived child process per call**, not a persistent
Windows computer-use session. Each request has a **30-second** default
deadline and a **1 MiB** stdout limit. Results are structured JSON objects
with a separate **256 KiB** MCP structured-content envelope bound. Errors
can occur after a Windows request was acted upon.

## Safe operating procedure

1. Confirm the printer and its capabilities. Ask the person at the machine
   what paper is physically loaded; `print.media` is a declaration, **not a sensor**.
2. Record the physical paper using `print.set_media` when necessary.
3. Prepare a supported local file and use `print.inspect` for non-printing
   validation.
4. Submit only once with `print.submit`; retain its returned printer and job ID
   when available.
5. Use `print.queue` and `print.job` to reconcile uncertain completion.
   Do **not** blindly retry a failed/timed-out submission: it might already
   have produced pages. `print.cancel` also has no automatic retry.

The adapter does not scan documents or infer physical tray state.
Submission acknowledgement is not proof that the correct pages were physically
produced; a human may still need to inspect the output.

## Validation boundaries

`test/print.test.ts` exercises argument construction, file bounds, bridge
process/error behavior, and MCP contracts with fixtures. Run
`npm run check && npm test && npm run build` on the repository source.
Those tests do not validate live Windows printer hardware, local executable
configuration, service activation, paper choice or final physical output.
Verify those separately using `print.status`, `print.capabilities`,
reconciled job state, and an authorized physical test page.
