import { inngest } from "@/inngest/client";

/** Hands a planned run to the executor. */
export async function triggerRun(runId: string): Promise<void> {
  await inngest.send({ name: "run/requested", data: { runId } });
}

/** Asks the executor to stop; cells left pending stay pending and resume on re-run. */
export async function cancelRun(runId: string): Promise<void> {
  await inngest.send({ name: "run/cancelled", data: { runId } });
}
