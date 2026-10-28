# Operator traffic introspection

Use ngrok's existing local HTTP capture to measure which MCP operations occur in
operator traffic. The repository script reads the Agent API and prints aggregate
metadata; it does not add MCP tools, instrumentation, a recorder, or a service.

## Run

From the repository root with Node 24 or newer:

```bash
npm run operator:introspect
npm run --silent operator:introspect -- --json
node scripts/inspect-ngrok.mjs --json > /tmp/opencode-usage-summary.json
```

The default source is `http://127.0.0.1:4040/api/`. Only POST requests with
pathname `/opencode-connect/mcp` are analyzed; query parameters are ignored.
This is the public host-ingress path captured by ngrok before Caddy rewrites it
to the connector's backend `/mcp` route. For direct/proxy deployments that capture
that backend route, select it explicitly with `--path /mcp`. To select another
local Agent API or MCP pathname:

```bash
npm run operator:introspect -- --api-url http://127.0.0.1:4041/api/ --path /mcp --limit 2000
```

For an existing JSON response from `GET /api/requests/http`, use offline mode:

```bash
npm run --silent operator:introspect -- --input /private/capture.json --json
```

Use `--silent` with npm when piping or redirecting JSON to suppress npm banners.

Offline input must be an Agent API object with a `requests` array. Cloud Traffic
Inspector exports use separate contracts and are not accepted by this script.
The default limit is 1,000 records; the maximum is 10,000. Input/API responses are
bounded to 64 MiB. Offline mode never contacts ngrok.

## Report

- Per-tool counts, HTTP exchange p50/p95 latency in milliseconds, and separate
  success, tool error, JSON-RPC error, HTTP error, pending, and unknown counts.
- Observed MCP methods and structured `nextCall.tool` continuation targets.
- Adjacent tool-call pairs within the same captured MCP session and tunnel,
  ordered by request start time. Session identifiers are used only in memory.
  Unreadable calls break adjacency, tied times do not establish order, and a
  missing timestamp makes that session's sequence unavailable.
- The sampled time window, unreadable request count, duplicates, missing
  correlation, endpoint inspection settings, and sampling limitations.

HTTP 200 alone is not success. A complete JSON or SSE response must contain one
JSON-RPC reply matching the request ID and a valid MCP tool result. A result with
`isError: true` is a tool error. Missing, malformed, unsupported, truncated, or
uncorrelated results remain unknown; an absent HTTP response is pending.
The parser handles HTTP chunk framing and gzip, deflate, and Brotli encoding.
Latency uses the Agent API's nanosecond `duration` field and describes the HTTP
exchange, including transport overhead. It is not native job duration.

A continuation target means it was returned, not that it was followed. A session
can span multiple tasks or clients, and adjacent calls can run concurrently.
Stateless clients without MCP session headers have no sequence report; the script
does not invent correlation from IP addresses, authorization, or timing.

## Capture availability and boundaries

ngrok must already be inspecting the endpoint for payload analysis. The script
checks `GET /api/endpoints`, with `GET /api/tunnels` as an older-agent fallback,
and reports disabled or unavailable inspection. It never enables capture,
changes ngrok configuration, restarts a tunnel, replays requests, or clears
captured traffic. Capture configuration belongs to the host ingress owner.

The [Agent API](https://ngrok.com/docs/gateway/agent/api) exposes an in-memory
buffer; records are evicted when `inspect_db_size` is exceeded. The request limit,
eviction, capture being disabled, and body truncation can all leave a partial
sample. An empty report is not evidence of zero operator activity. Check the
[inspection interface](https://ngrok.com/docs/gateway/agent/web-inspection-interface)
when coverage is unclear.

Only traffic through that ngrok agent is visible. Direct localhost MCP calls,
native worker tools, client-side failures, model-loaded tool definitions, token
cost, and user-task success are outside this report. Use the existing host
ingress `just activity` timer for recent authenticated ingress activity and
native worker histories for worker execution.

The analyzer handles raw captured payloads in memory but emits only summaries.
It excludes request arguments, commands, prompts, file contents, result text,
HTTP headers, credentials, session IDs, client addresses, and endpoint URLs.
Tool/method names and times remain in the summary. It does not persist raw
capture or print raw API errors. Existing input capture files retain their own
sensitivity. Redirect the script's JSON summary, rather than raw captures, when
keeping evidence for catalog decisions.
