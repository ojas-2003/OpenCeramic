import { createColumn, createRows, createTable, nextColumnPosition } from "@/db/queries";
import type { Table } from "@/db/schema";

/**
 * The demo table from DESIGN.md section 5.1: six enrichment columns, four DAG
 * levels, all three run modes. A reviewer can load it and press Run without
 * uploading anything.
 *
 *   Website -> Resolve company -> Revenue
 *                              -> Talent flow
 *                              -> Find CEO -> Reveal contact -> Validate email
 *                                                            -> Social handles
 */
const DEMO_DOMAINS = [
  "stripe.com", "linear.app", "vercel.com", "supabase.com", "railway.app",
  "resend.com", "clerk.com", "planetscale.com", "neon.tech", "upstash.com",
  "inngest.com", "trigger.dev", "cal.com", "posthog.com", "sentry.io",
  "retool.com", "airbyte.com", "dbt.com", "hex.tech", "modal.com",
  "replicate.com", "huggingface.co", "anthropic.com", "openai.com", "ramp.com",
];

export const DEMO_TABLE_NAME = "Demo — Seed-stage SaaS";

export async function seedDemoTable(): Promise<{ table: Table; columns: number; rows: number }> {
  const table = await createTable(DEMO_TABLE_NAME, "company");

  const website = await createColumn({
    tableId: table.id,
    name: "Website",
    kind: "input",
    config: { inputs: {} },
    position: await nextColumnPosition(table.id),
  });

  const add = async (
    name: string,
    enrichmentId: string,
    inputs: Record<string, string>,
  ) =>
    createColumn({
      tableId: table.id,
      name,
      kind: "enrichment",
      enrichmentId,
      enrichmentVersion: 1,
      config: { inputs },
      position: await nextColumnPosition(table.id),
    });

  const company = await add("Resolve company", "fiber.company.kitchenSink", {
    domain: website.id,
  });
  await add("Revenue", "fiber.company.revenue", {
    linkedin_url: `${company.id}.linkedin_url`,
  });
  await add("Talent flow", "fiber.company.talentFlow", {
    linkedin_url: `${company.id}.linkedin_url`,
  });
  const ceo = await add("Find CEO", "fiber.people.findAtCompany", {
    company_linkedin_url: `${company.id}.linkedin_url`,
  });
  const contact = await add("Reveal contact", "fiber.contact.reveal", {
    linkedin_url: `${ceo.id}.linkedin_url`,
  });
  await add("Validate email", "fiber.email.validate", {
    email: `${contact.id}.email`,
  });
  await add("Social handles", "fiber.social.handles", {
    linkedin_url: `${ceo.id}.linkedin_url`,
  });

  // Input cells are done with the domain; every enrichment cell starts idle.
  const rows = await createRows(
    table.id,
    DEMO_DOMAINS.map((domain) => ({ Website: domain })),
  );

  // Website plus seven enrichment columns.
  return { table, columns: 8, rows: rows.length };
}

// `pnpm db:seed`
if (process.argv[1]?.endsWith("seed.ts")) {
  seedDemoTable()
    .then((r) => {
      console.log(`Seeded "${DEMO_TABLE_NAME}": ${r.rows} rows, ${r.columns} columns`);
      console.log(`  /tables/${r.table.id}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
