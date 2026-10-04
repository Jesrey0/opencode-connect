// Connector application errors use codes outside the JSON-RPC reserved range.
// CallbackEndpointError is prescribed by the OpenAI MCP Events extension.
export const EventErrorCode = {
  AuthorizationDenied: 1001,
  SubscriptionCapacityExceeded: 1002,
  CallbackEndpointError: -32015,
} as const;
