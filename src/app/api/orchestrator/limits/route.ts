import { NextResponse } from "next/server";
import { getOrchestratorProviderLimits } from "@/lib/orchestrator/limits";

export async function GET() {
  try {
    return NextResponse.json({ ceilingPercent: 80, limits: await getOrchestratorProviderLimits() });
  } catch (error) {
    console.error("[API] GET /api/orchestrator/limits error:", error);
    return NextResponse.json({ error: "Failed to fetch orchestrator limits" }, { status: 500 });
  }
}
