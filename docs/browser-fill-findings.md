# Browser fill and lease findings — October 20, 2026

## Audio customization limit

NotebookLM's current Audio Overview customization textarea declares
`maxlength="5000"`, measured by HTML in UTF-16 code units. The exact accessible
name is `What should the AI hosts focus on in this episode?`. Inspection opened
the customization dialog, read control metadata and closed it without entering
text or starting generation.

The reported 9,215- and 5,727-character fills exceed that bound. Both left the
textbox empty according to subsequent exact-value observations. The successful
4,666-character fast insertion fits the bound. This strongly explains the
reported length pattern; the historical native error codes were not retained,
so retrospective attribution is an inference. Successful insertion into a
different 15,945-character source field does not establish this field's limit.
Neither fill nor type_text overrides a native maxlength.

The previous MCP error envelope contained useful structured fields but an empty
standard content array. A live invalid-lease probe reproduced that shape and the
platform's added `INVALID_ARGUMENT` classification. Clients rendering only the
standard content could therefore show `Error calling MCP tool: []` and lose the
native cause. Version 0.14.2 includes the same safe error fields in both formats.
`site_limit` now states the exact UTF-16 bound and confirms no text dispatch.
Arguments and submitted text are not echoed. Sanitized journal events retain
tool name, code/layer and dispatch state without messages or page content.

The independent fill completion defect corrected in 0.14.1 remains covered:
after a completed fill, a legitimate change handler may move focus or disable
the accepted control. Final verification checks identity and exact value without
requiring continued focus/editability. That case leaves text in the field and
does not match the empty-field observations from this incident.

## Attachment recovery

The reported failure occurred approximately October 20, 09:50–09:53 PHT
(01:50–01:53 UTC), after consecutive 30-second waits. That sequence does not
establish five-minute idle expiry. No service journal entries were available
for the surrounding window; the precise historical trigger remains unresolved.

Controlled tests reproduced these separate defects and verify their corrections:

- A dead socket could retain a lease and report a tab as leased until status
  reconciled it. Tab discovery now reconciles socket/browser identity; summaries
  require a connected socket and matching browser. Explicit attachment discards
  a dead lease while preserving healthy lease conflicts and Windows approval.
- Detach previously required a healthy page/socket. It now authenticates the
  lease owner and token before releasing resources, without a page operation.
- A short request queued behind a longer operation could exhaust its deadline
  and invalidate an unrelated live attachment. Public overlap now returns
  `busy` before dispatch. Private requests expiring before execution reject
  without disconnecting. A running operation's deadline or cancellation can
  still invalidate its attachment when the outcome is uncertain.

The exact reported ordering of `attached:false` followed by `leased:true` was
not reproduced as consecutive observations of one unchanged adapter. Different
browser selection, intervening operations or worker changes cannot be ruled out.
No automatic reconnect or action replay was introduced. Five-minute idle cleanup
continues to preserve Chrome and retain an explanatory status diagnostic.

For long generation, release the attachment after submission, then rediscover,
attach and inspect during verification. An unavailable lease does not establish
that generation failed and is not a reason to resubmit generation.
