import { getTask, snapshot, subscribeTask } from "@/lib/orchestrator/store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getTask(id)) return new Response("Task not found", { status: 404 });
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        const task = getTask(id);
        if (!task) return;
        controller.enqueue(
          encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot(task))}\n\n`)
        );
        if (["completed", "failed", "cancelled"].includes(task.state)) {
          unsubscribe();
          controller.close();
        }
      };
      unsubscribe = subscribeTask(id, send);
      send();
      const heartbeat = setInterval(() => {
        try {
          send();
        } catch {
          clearInterval(heartbeat);
        }
      }, 5_000);
      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
