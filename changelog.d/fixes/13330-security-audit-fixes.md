- **fix(security):** five independent security-audit fixes. DNS-rebinding pinning
  (GHSA-cmhj-wh2f-9cgx) is now applied to the provider dispatch path itself
  (`BaseExecutor.resolvePinnedFetch()`), not only to remote image fetch, closing the classic
  TOCTOU window on the highest-risk `providerSpecificData.baseUrl` override path. API keys no
  longer persist in plaintext — `createApiKey()`/`regenerateApiKey()` store an inert
  `redacted:<id>` placeholder, auth checks only ever hit `key_hash`, and legacy plaintext rows
  are encrypted at rest in place on boot. The rate limiter no longer fails fully open when Redis
  errors — it falls back to the in-memory limiter instead of allowing every request unconditionally.
  Boot now fails fast in production when `STORAGE_ENCRYPTION_KEY` is missing instead of silently
  persisting credentials in plaintext with only a warning. And the MCP scope-enforcement gap is
  closed: `withScopeEnforcement()` now forces scope checks for any caller resolved from a real
  HTTP `Authorization` header that does not already hold `manage`/`admin` scope, even when
  `OMNIROUTE_MCP_ENFORCE_SCOPES` is off by default — so a key granted only the narrow
  `mcp:connect` bypass scope can no longer invoke arbitrary MCP tools once remote access is
  enabled ([#13330](https://github.com/diegosouzapw/OmniRoute/pull/13330)) — thanks @JJAbrams-eng
