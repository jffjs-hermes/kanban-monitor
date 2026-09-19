// POST/GET/DELETE /mcp — MCP Streamable HTTP transport on the same process
// (spec §4.1; M-1 #3). Routes MCP JSON-RPC traffic to the shared boardRuntime
// via the thin adapter in lib/server/mcp. Additive: the UI, REST, and SSE
// surfaces are untouched.
//
//   POST   /mcp   — JSON-RPC messages (initialize, tools/call, resources/read)
//   GET    /mcp   — SSE stream for server-initiated messages (per session)
//   DELETE /mcp   — terminate a session
//
// No auth on this surface in this increment (deferred; binds as REST does).

import { handleMcpRequest } from '$lib/server/mcp';

export function POST(event: { request: Request }) {
  return handleMcpRequest(event.request);
}

export function GET(event: { request: Request }) {
  return handleMcpRequest(event.request);
}

export function DELETE(event: { request: Request }) {
  return handleMcpRequest(event.request);
}
