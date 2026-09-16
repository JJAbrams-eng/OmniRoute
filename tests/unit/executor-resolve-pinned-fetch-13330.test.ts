// #13330 mandatory item 1 — `BaseExecutor.resolvePinnedFetch()` (open-sse/executors/base.ts)
// is the new DNS-rebinding pin (GHSA-cmhj-wh2f-9cgx) applied to the provider dispatch path
// itself, extending the mechanism `dnsPin.ts` already covered for remote image fetch. Before
// this PR nothing exercised it directly (`rg -l "resolvePinnedFetch" tests/unit` was empty) —
// these tests drive the real method end-to-end: bypass rules (local/self-hosted providers,
// guard disabled, invalid URL) plus a live-server proof that the returned fetch is genuinely
// pinned (a different function than the global `fetch`, and it reaches the pinned address).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns";

import { BaseExecutor } from "../../open-sse/executors/base.ts";

// resolvePinnedFetch() is `protected` — expose it through a thin subclass instead of an
// `as any` cast (no-explicit-any is an ESLint error in tests/).
class TestableExecutor extends BaseExecutor {
  callResolvePinnedFetch(url: string): Promise<typeof fetch> {
    return this.resolvePinnedFetch(url);
  }
}

const ENV_KEYS = ["OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS", "OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS"];

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

async function withHttpServer(fn: (port: number) => Promise<void>) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-dispatch-response");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn((address as { port: number }).port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("resolvePinnedFetch falls back to the global fetch for a local provider (bypass)", async () => {
  const executor = new TestableExecutor("ollama-local", {});
  const result = await executor.callResolvePinnedFetch("https://example.com/v1/chat");
  assert.equal(result, fetch, "self-hosted/local providers must skip pinning entirely");
});

test("resolvePinnedFetch falls back to the global fetch for an empty url", async () => {
  const executor = new TestableExecutor("openai", {});
  const result = await executor.callResolvePinnedFetch("");
  assert.equal(result, fetch);
});

test("resolvePinnedFetch falls back to the global fetch for an unparsable url", async () => {
  const executor = new TestableExecutor("openai", {});
  const result = await executor.callResolvePinnedFetch("not a url");
  assert.equal(result, fetch);
});

test('resolvePinnedFetch falls back to the global fetch when the outbound guard is disabled ("none")', async () => {
  await withEnv({ OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS: "true" }, async () => {
    const executor = new TestableExecutor("openai", {});
    const result = await executor.callResolvePinnedFetch("https://example.com/v1/chat");
    assert.equal(result, fetch, 'guard="none" must skip pinning (explicit operator opt-out)');
  });
});

test("resolvePinnedFetch returns a genuinely pinned fetch (not the global fetch) that reaches the resolved address", async () => {
  // Force every DNS answer to the loopback address the local server is bound to, so the
  // pin target is deterministic regardless of the sandbox's real resolver behavior. Node
  // --test runs each file in its own process, so this rebinding does not leak across files.
  const originalLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = (async (
    _hostname: string,
    options?: { all?: boolean }
  ) => {
    const record = { address: "127.0.0.1", family: 4 };
    return options && options.all ? [record] : record;
  }) as typeof dns.promises.lookup;

  try {
    await withEnv({ OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS: "true" }, async () => {
      await withHttpServer(async (port) => {
        // A non-local provider (not in LOCAL_PROVIDERS/SELF_HOSTED_CHAT_PROVIDER_IDS) so the
        // bypass in resolvePinnedFetch does not short-circuit before the guard runs.
        const executor = new TestableExecutor("openai", {});
        const pinnedFetch = await executor.callResolvePinnedFetch(
          `http://dispatch-pin-nonexistent-host.invalid:${port}/v1/chat`
        );
        assert.notEqual(
          pinnedFetch,
          fetch,
          "a resolvable non-local dispatch URL must return a pinned fetch, not the global fetch"
        );
        const response = await pinnedFetch(
          `http://dispatch-pin-nonexistent-host.invalid:${port}/v1/chat`
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "pinned-dispatch-response");
      });
    });
  } finally {
    (dns.promises as { lookup: unknown }).lookup = originalLookup;
  }
});
