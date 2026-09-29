import { isLocalProvider, isSelfHostedChatProvider } from "@/shared/constants/providers";
import { getProviderValidationGuard } from "@/shared/network/outboundUrlGuardPolicy";
import {
  parseAndValidateNonMetadataUrl,
  parseAndValidatePublicUrl,
} from "@/shared/network/outboundUrlGuard";
import { resolveAndValidateAddresses } from "@/shared/network/dnsPin";
import { createPinnedDispatcher } from "@/shared/network/dnsPinnedFetch";
import {
  hasAmbientProxyContext,
  isDirectFetchContext,
  isTlsFingerprintActive,
  resolveProxyForRequest,
} from "../utils/proxyFetch.ts";

/**
 * String-level SSRF guard for the runtime dispatch path (GHSA-4f49-hj64-448x) — moved verbatim
 * from `BaseExecutor.assertOutboundUrlAllowed()` (which now delegates here) so the guard and the
 * connect-time pin below live together and `base.ts` stays within its file-size ceiling.
 * Local / self-hosted providers are exempt; `public-only` blocks private + metadata, the default
 * mode blocks the cloud-metadata IMDS pivot. Throws on a blocked URL.
 */
export function assertDispatchUrlAllowed(provider: string, url: string): void {
  if (!url) return;
  if (isLocalProvider(provider) || isSelfHostedChatProvider(provider)) return;
  if (getProviderValidationGuard() === "public-only") {
    parseAndValidatePublicUrl(url);
    return;
  }
  parseAndValidateNonMetadataUrl(url);
}

/**
 * True when a request to `url`, issued from the current async scope, would take the ordinary
 * direct undici path of the patched fetch — so a connect-time-pinned `dispatcher` can be handed
 * to it without skipping anything the patched fetch does for that request.
 *
 * Deliberately conservative — anything else answers `false` and the caller keeps its plain
 * (string-level) URL guard instead of pinning:
 * - a proxy applies (per-connection context proxy or env proxy): the proxy resolves the name
 *   itself, and a pinned dispatcher would bypass it and leak the egress IP;
 * - the explicit direct sentinel is active: `patchedFetch` then uses the native fetch, which
 *   cannot drive an undici dispatcher;
 * - TLS-fingerprint impersonation would carry the request: a caller dispatcher short-circuits it;
 * - the proxy configuration cannot be resolved (`resolveProxyForRequest` throws).
 */
export function canPinDirectConnection(provider: string, url: string): boolean {
  if (hasAmbientProxyContext() || isDirectFetchContext()) return false;
  if (isTlsFingerprintActive(provider, false)) return false;
  try {
    return resolveProxyForRequest(url).source === "direct";
  } catch {
    return false;
  }
}

/**
 * DNS-rebinding guard for the runtime provider dispatch path (GHSA-cmhj-wh2f-9cgx).
 * `BaseExecutor.assertOutboundUrlAllowed()` validates the URL's hostname as a literal string, but
 * the real `fetch()` re-resolves DNS at connect time — a short-TTL record can be public for the
 * string check and private/metadata moments later (classic TOCTOU). Highest risk on the
 * `providerSpecificData.baseUrl` override path (#6147), applied uniformly for defense in depth.
 *
 * Resolves the host once, validates every answer against the same guard mode, and pins the
 * connection to a validated address. The pin travels as `init.dispatcher` on a call to the
 * ambient global `fetch` — the patched one from `proxyFetch.ts`, or whatever a test stubbed in —
 * never through a private fetch of our own, so proxy routing, upstream-status capture and
 * request logging are untouched.
 *
 * Returns the plain global `fetch` (no pin, string-level guard only) when the provider is exempt,
 * the guard is disabled (`"none"`), the URL does not parse, or {@link canPinDirectConnection}
 * says a proxy / TLS-impersonation / explicit-direct route applies. When in doubt: do NOT pin.
 */
export async function resolveDispatchPinnedFetch(
  provider: string,
  url: string
): Promise<typeof fetch> {
  if (!url) return fetch;
  if (isLocalProvider(provider) || isSelfHostedChatProvider(provider)) return fetch;
  const guard = getProviderValidationGuard();
  if (guard === "none") return fetch;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fetch;
  }
  if (!canPinDirectConnection(provider, url)) return fetch;

  const addresses = await resolveAndValidateAddresses(parsed, guard);
  if (!addresses.length) return fetch;
  const dispatcher = createPinnedDispatcher(addresses[0].address, addresses[0].family);
  return (async (input, init) => {
    try {
      return await fetch(input, { ...init, dispatcher } as RequestInit);
    } finally {
      // Not awaited: `close()` resolves once the request has finished, and the response body
      // cannot finish before the caller starts reading it.
      void dispatcher.close().catch(() => undefined);
    }
  }) as typeof fetch;
}

/** `fetch(url, init)` for provider dispatch, with the DNS-rebinding pin of {@link resolveDispatchPinnedFetch}. */
export async function dispatchPinned(
  provider: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  return (await resolveDispatchPinnedFetch(provider, url))(url, init);
}
