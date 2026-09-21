// Test-only prelude for mcp-auth-integration tests. Imported FIRST so that the
// hooks.server.ts module-level boot check (warnIfAgentOpenOnNonLoopback) sees a
// loopback bind + a configured token and stays silent regardless of the bun
// runner's ambient env. Auth for each scenario is toggled afterward via the
// setAgentTokenForTest seam, so this load-time value is never what gates a test.
process.env.AGENT_HOST = '127.0.0.1';
process.env.HOST = '127.0.0.1';
process.env.AGENT_TOKEN = 'integration-cfg';