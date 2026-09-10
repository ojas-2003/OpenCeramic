import { createColumn, createRows, createSource, createTable, nextColumnPosition } from "@/db/queries";
import type { RowSourceRecord, Table } from "@/db/schema";
import { getFiberClient } from "@/fiber";
import "@/sources";
import { getOrThrow as getSource } from "@/sources/registry";

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

export const SIGNALS_TABLE_NAME = "Demo — Funding signals";

/**
 * The push half of the demo: an empty table with a tracker watching it.
 *
 * It is a separate table rather than a second entry point on the one above,
 * because the two are fed by different identifiers. A CSV gives you a domain,
 * and "Resolve company" needs one. A tracker signal never carries a domain —
 * only a LinkedIn URL — so the chain here starts from that instead. Putting
 * both on one table would leave every tracker row with an empty Website and a
 * whole column of skipped cells.
 *
 *   LinkedIn URL -> Revenue
 *                -> Talent flow
 *                -> Find CEO -> Reveal contact -> Validate email
 */
export async function seedSignalsTable(): Promise<{
  table: Table;
  source: RowSourceRecord;
  columns: number;
}> {
  const table = await createTable(SIGNALS_TABLE_NAME, "company");

  const linkedin = await createColumn({
    tableId: table.id,
    name: "LinkedIn URL",
    kind: "input",
    config: { inputs: {} },
    position: await nextColumnPosition(table.id),
  });

  const add = async (name: string, enrichmentId: string, inputs: Record<string, string>) =>
    createColumn({
      tableId: table.id,
      name,
      kind: "enrichment",
      enrichmentId,
      enrichmentVersion: 1,
      config: { inputs },
      position: await nextColumnPosition(table.id),
    });

  await add("Revenue", "fiber.company.revenue", { linkedin_url: linkedin.id });
  await add("Talent flow", "fiber.company.talentFlow", { linkedin_url: linkedin.id });
  const ceo = await add("Find CEO", "fiber.people.findAtCompany", {
    company_linkedin_url: linkedin.id,
  });
  const contact = await add("Reveal contact", "fiber.contact.reveal", {
    linkedin_url: `${ceo.id}.linkedin_url`,
  });
  await add("Validate email", "fiber.email.validate", { email: `${contact.id}.email` });

  // setup() creates the tracker list on Fiber and returns the id that addresses
  // it. Under FIBER_FAKE=1 that is served from a fixture, which is what keeps
  // "Fire test signal" working end to end while the sandbox returns 501.
  const tracker = getSource("fiber.source.tracker");
  const config = tracker.config.parse({
    entity: "company",
    ruleIds: ["new_funding_round", "funding_stage_changed"],
  });
  const patch = await tracker.setup!(config, { fiber: getFiberClient(), logger: () => {} });

  const source = await createSource({
    tableId: table.id,
    kind: "tracker",
    name: "Funding rounds",
    config: { ...config, ...patch },
    autoEnrich: true,
    status: "active",
    cursor: {},
  });

  // No rows: they arrive on their own.
  return { table, source, columns: 6 };
}

// `pnpm db:seed`
if (process.argv[1]?.endsWith("seed.ts")) {
  // tsx does not read .env.local on its own, and the seed needs both
  // DATABASE_URL and FIBER_FAKE.
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Falls back to the ambient environment (CI).
  }

  Promise.all([seedDemoTable(), seedSignalsTable()])
    .then(([demo, signals]) => {
      console.log(`Seeded "${DEMO_TABLE_NAME}": ${demo.rows} rows, ${demo.columns} columns`);
      console.log(`  /tables/${demo.table.id}`);
      console.log(`Seeded "${SIGNALS_TABLE_NAME}": 0 rows, ${signals.columns} columns`);
      console.log(`  /tables/${signals.table.id}`);
      console.log(`  tracker "${signals.source.name}" is watching — press "Fire test signal"`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
