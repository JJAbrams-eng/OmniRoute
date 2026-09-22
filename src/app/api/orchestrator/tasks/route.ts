import { NextResponse } from "next/server";
import { CreateOrchestratorTaskSchema } from "@/lib/orchestrator/types";
import { startOrchestrator } from "@/lib/orchestrator/engine";
import { listTasks } from "@/lib/orchestrator/store";

export async function POST(request: Request) {
  try {
    const parsed = CreateOrchestratorTaskSchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const task = await startOrchestrator(parsed.data);
    return NextResponse.json({ task }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start orchestrator" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ceilingPercent: 80,
    defaultModels: (
      process.env.OMNIROUTE_ORCHESTRATOR_MODELS || "auto/coding,auto/reasoning,auto/cheap"
    )
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
      .slice(0, 18),
    maxAgents: 18,
    history: listTasks(30),
  });
}
