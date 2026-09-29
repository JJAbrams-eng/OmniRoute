import { isCloudMetadataHost, isPrivateHost, type OutboundUrlGuardMode } from "./outboundUrlGuard";
import {
  defaultDnsLookup,
  resolveHostnameAddresses,
  type DnsLookup,
  type DnsLookupResult,
} from "./dnsPinnedFetch";

/**
 * Resolve every DNS answer for `url`'s hostname and validate each resolved address against
 * `guard`, closing the DNS-rebinding TOCTOU window (GHSA-cmhj-wh2f-9cgx): a hostname-string check
 * performed at request validation time can pass while a later, independent DNS lookup at connect
 * time returns a different — possibly private/metadata — address. Returns the validated
 * addresses so the caller can pin the connection to one of them (`createPinnedDispatcher` /
 * `createPinnedFetch` in `dnsPinnedFetch.ts`).
 *
 * Returns `[]` (nothing to pin) when `guard` is `"none"` (outbound guard disabled — explicit
 * operator opt-in) or the URL has no hostname. An IP-literal host is returned as a single entry.
 * Fails closed: a lookup error or an empty answer set throws.
 */
export async function resolveAndValidateAddresses(
  url: URL,
  guard: OutboundUrlGuardMode,
  lookup: DnsLookup = defaultDnsLookup
): Promise<DnsLookupResult[]> {
  if (guard === "none") return [];
  const hostname = url.hostname;

  let resolved: DnsLookupResult[];
  try {
    resolved = await resolveHostnameAddresses(hostname, lookup);
  } catch {
    throw new Error(`Outbound host could not be resolved (blocked): ${hostname}`);
  }

  for (const { address } of resolved) {
    if (guard === "public-only" && isPrivateHost(address)) {
      throw new Error(
        `Outbound host resolves to a blocked private address (DNS rebinding): ${hostname}`
      );
    }
    if (guard === "block-metadata" && isCloudMetadataHost(address)) {
      throw new Error(
        `Outbound host resolves to a blocked cloud-metadata address (DNS rebinding): ${hostname}`
      );
    }
  }

  return resolved;
}
