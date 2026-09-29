- **fix(security):** four independent security-audit fixes. DNS-rebinding pinning
  (GHSA-cmhj-wh2f-9cgx) now also covers the provider dispatch path
  (`dispatchPinned()` in `open-sse/executors/dispatchPin.ts`), not only remote image fetch,
  closing the classic TOCTOU window on the highest-risk `providerSpecificData.baseUrl` override
  path; the pin is only applied to a plain direct connection and is handed to the ambient patched
  `fetch` as a dispatcher, so configured outbound proxies, TLS impersonation and request logging
  are never bypassed. The rate limiter no longer fails fully open when Redis errors — it falls
  back to the in-memory limiter instead of allowing every request unconditionally. Boot now fails
  fast in production when `STORAGE_ENCRYPTION_KEY` is missing instead of silently persisting
  credentials in plaintext with only a warning, and the persisted `JWT_SECRET`/`API_KEY_SECRET`
  are encrypted at rest. And the MCP scope-enforcement gap is closed:
  `withScopeEnforcement()` now forces scope checks for any caller resolved from a real HTTP
  `Authorization` header that does not already hold `manage`/`admin` scope, even when
  `OMNIROUTE_MCP_ENFORCE_SCOPES` is off by default — so a key granted only the narrow
  `mcp:connect` bypass scope can no longer invoke arbitrary MCP tools once remote access is
  enabled ([#13330](https://github.com/diegosouzapw/OmniRoute/pull/13330)) — thanks @JJAbrams-eng
