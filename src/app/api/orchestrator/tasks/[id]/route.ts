import { NextResponse } from "next/server";
import { getTask, snapshot } from "@/lib/orchestrator/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const task = getTask(id);
  return task
    ? NextResponse.json(snapshot(task))
    : NextResponse.json({ error: "Task not found" }, { status: 404 });
}
