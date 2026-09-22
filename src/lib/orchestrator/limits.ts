import { getProviderConnections } from "@/lib/db/providers";
import { getSanitizedCachedProviderLimitsMap } from "@/lib/usage/providerLimits";

export interface OrchestratorProviderLimit {
  connectionId: string;
  provider: string;
  label: string;
  remainingPercent: number | null;
  quotaCount: number;
  fetchedAt: string | null;
  source: string | null;
  status: "known" | "unknown";
}

function asQuotaList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value))
    return value.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object")
    );
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

export function calculateRemainingPercent(quota: Record<string, unknown>): number | null {
  if (quota.unlimited === true) return 100;
  const direct = Number(quota.remainingPercentage);
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
  const total = Number(quota.total);
  const used = Number(quota.used ?? 0);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) {
    return Math.max(0, Math.min(100, ((total - used) / total) * 100));
  }
  return null;
}

export async function getOrchestratorProviderLimits(): Promise<OrchestratorProviderLimit[]> {
  const [connections, caches] = await Promise.all([
    getProviderConnections({ isActive: true }),
    getSanitizedCachedProviderLimitsMap(),
  ]);

  return connections.map((connection) => {
    const cache = caches[connection.id];
    const quotas = cache?.quotas ? Object.values(cache.quotas).flatMap(asQuotaList) : [];
    const percentages = quotas
      .map(calculateRemainingPercent)
      .filter((value): value is number => value !== null);
    return {
      connectionId: connection.id,
      provider: String(connection.provider || "unknown"),
      label: String(connection.name || connection.email || connection.id),
      remainingPercent: percentages.length ? Math.min(...percentages) : null,
      quotaCount: quotas.length,
      fetchedAt: cache?.fetchedAt || null,
      source: cache?.source || null,
      status: percentages.length ? "known" : "unknown",
    };
  });
}
