// #13330 mandatory item 1 — `resolveDispatchPinnedFetch()` (open-sse/executors/dispatchPin.ts, used by BaseExecutor dispatch)
// is the DNS-rebinding pin (GHSA-cmhj-wh2f-9cgx) applied to the provider dispatch path itself.
// It must pin ONLY a plain direct connection and hand the pin to the ambient global `fetch`
// (patched proxyFetch, or a test stub) as `init.dispatcher` — never swap in a private fetch, or a
// configured outbound proxy would be bypassed (IP leak) and stubbed-fetch tests would reach the
// real upstream. These tests drive the real method: bypass rules (local/self-hosted providers,
// guard disabled, invalid URL, proxy/direct-sentinel routes) plus live proof that a pinned call
// goes through the global fetch and reaches the validated address.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns";

import { runWithDirectFetchContext } from "../../open-sse/utils/proxyFetch.ts";

import { resolveDispatchPinnedFetch } from "../../open-sse/executors/dispatchPin.ts";

const ENV_KEYS = [
  "OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS",
  "OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

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

test("resolveDispatchPinnedFetch falls back to the global fetch for a local provider (bypass)", async () => {
  const result = await resolveDispatchPinnedFetch("ollama-local", "https://example.com/v1/chat");
  assert.equal(result, fetch, "self-hosted/local providers must skip pinning entirely");
});

test("resolveDispatchPinnedFetch falls back to the global fetch for an empty url", async () => {
  const result = await resolveDispatchPinnedFetch("openai", "");
  assert.equal(result, fetch);
});

test("resolveDispatchPinnedFetch falls back to the global fetch for an unparsable url", async () => {
  const result = await resolveDispatchPinnedFetch("openai", "not a url");
  assert.equal(result, fetch);
});

test('resolveDispatchPinnedFetch falls back to the global fetch when the outbound guard is disabled ("none")', async () => {
  await withEnv({ OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS: "true" }, async () => {
    const result = await resolveDispatchPinnedFetch("openai", "https://example.com/v1/chat");
    assert.equal(result, fetch, 'guard="none" must skip pinning (explicit operator opt-out)');
  });
});

function forceLoopbackDns() {
  // Force every DNS answer to the loopback address the local server is bound to, so the pin
  // target is deterministic regardless of the sandbox's real resolver behavior. Node --test
  // runs each file in its own process, so this rebinding does not leak across files.
  const originalLookup = dns.promises.lookup;
  let lookups = 0;
  (dns.promises as { lookup: unknown }).lookup = (async (
    _hostname: string,
    options?: { all?: boolean }
  ) => {
    lookups++;
    const record = { address: "127.0.0.1", family: 4 };
    return options && options.all ? [record] : record;
  }) as typeof dns.promises.lookup;
  return {
    lookups: () => lookups,
    restore: () => {
      (dns.promises as { lookup: unknown }).lookup = originalLookup;
    },
  };
}

test("resolveDispatchPinnedFetch pins through the ambient global fetch and reaches the validated address", async () => {
  const dnsStub = forceLoopbackDns();
  try {
    await withEnv({ OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS: "true" }, async () => {
      await withHttpServer(async (port) => {
        // A non-local provider (not in LOCAL_PROVIDERS/SELF_HOSTED_CHAT_PROVIDER_IDS) so the
        // bypass in resolvePinnedFetch does not short-circuit before the guard runs.
        const url = `http://dispatch-pin-nonexistent-host.invalid:${port}/v1/chat`;
        const pinnedFetch = await resolveDispatchPinnedFetch("openai", url);
        assert.notEqual(
          pinnedFetch,
          fetch,
          "a resolvable direct dispatch URL must return a pinned wrapper, not the bare fetch"
        );
        assert.equal(dnsStub.lookups(), 1, "the host is resolved exactly once up front");
        const response = await pinnedFetch(url);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "pinned-dispatch-response");
      });
    });
  } finally {
    dnsStub.restore();
  }
});

test("resolveDispatchPinnedFetch calls the CURRENT global fetch with the pin as a dispatcher (stubs keep working)", async () => {
  const dnsStub = forceLoopbackDns();
  const realFetch = globalThis.fetch;
  const seen: Array<{ input: unknown; dispatcher: unknown }> = [];
  try {
    await withEnv({ OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS: "true" }, async () => {
      const url = "https://dispatch-pin-stubbed.invalid/v1/chat";
      const pinnedFetch = await resolveDispatchPinnedFetch("openai", url);
      // Stub installed AFTER the pin was built: the wrapper must resolve `fetch` at call time.
      globalThis.fetch = (async (input: unknown, init?: { dispatcher?: unknown }) => {
        seen.push({ input, dispatcher: init?.dispatcher });
        return new Response("from-stub", { status: 200 });
      }) as typeof fetch;
      const response = await pinnedFetch(url, { method: "POST" });
      assert.equal(await response.text(), "from-stub", "the stubbed global fetch served the call");
    });
  } finally {
    globalThis.fetch = realFetch;
    dnsStub.restore();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, "https://dispatch-pin-stubbed.invalid/v1/chat");
  assert.ok(seen[0].dispatcher, "the pinned dispatcher is handed to the global fetch");
});

test("resolveDispatchPinnedFetch does NOT pin when an env proxy applies (no DNS lookup, no dispatcher)", async () => {
  const dnsStub = forceLoopbackDns();
  try {
    await withEnv(
      { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
      async () => {
        const result = await resolveDispatchPinnedFetch(
          "openai",
          "https://dispatch-pin-proxied.invalid/v1"
        );
        assert.equal(
          result,
          fetch,
          "a proxied route must keep the ambient fetch — no pin, no IP leak"
        );
        assert.equal(dnsStub.lookups(), 0, "no local DNS lookup is done for a proxied route");
      }
    );
  } finally {
    dnsStub.restore();
  }
});

test("resolveDispatchPinnedFetch does NOT pin under the explicit direct-fetch sentinel", async () => {
  const dnsStub = forceLoopbackDns();
  try {
    await withEnv({}, async () => {
      const result = await runWithDirectFetchContext(() =>
        resolveDispatchPinnedFetch("openai", "https://dispatch-pin-direct.invalid/v1")
      );
      assert.equal(result, fetch);
      assert.equal(dnsStub.lookups(), 0);
    });
  } finally {
    dnsStub.restore();
  }
});

test("resolveDispatchPinnedFetch refuses a host whose DNS answer is a blocked address", async () => {
  const originalLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = (async (
    _hostname: string,
    options?: { all?: boolean }
  ) => {
    const record = { address: "169.254.169.254", family: 4 };
    return options && options.all ? [record] : record;
  }) as typeof dns.promises.lookup;
  try {
    await withEnv({}, async () => {
      await assert.rejects(
        () => resolveDispatchPinnedFetch("openai", "https://dispatch-pin-rebind.invalid/v1"),
        /DNS rebinding/
      );
    });
  } finally {
    (dns.promises as { lookup: unknown }).lookup = originalLookup;
  }
});
