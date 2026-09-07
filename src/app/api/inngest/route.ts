import { serve } from "inngest/next";

import { executeRun } from "@/engine/executor";
import { inngest } from "@/inngest/client";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [executeRun],
});
