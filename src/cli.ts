#!/usr/bin/env node
import { Command } from "commander";
import { parseHarFile } from "./parse/har.js";
import { parseCurlFile, parseCurlString } from "./parse/curl.js";
import { rankRequests } from "./analyze.js";
import { detectPagination } from "./pagination.js";
import { cleanHeaders, redactHeaders, saveRecipe, loadRecipe, type Recipe } from "./recipe.js";
import { runHarvest } from "./harvest.js";
import { probeRequest } from "./probe.js";
import type { CapturedRequest, RankedRequest } from "./types.js";

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const lastSeg = u.pathname.split("/").filter(Boolean).pop() ?? "data";
    const cleaned = lastSeg.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9_-]+/gi, "-");
    return cleaned || "data";
  } catch {
    return "data";
  }
}

interface BuildOpts {
  rowsPath?: string;
  format?: "json" | "xml" | "html";
  redact?: boolean;
}

function buildRecipe(
  request: CapturedRequest,
  opts: BuildOpts,
): { recipe: Recipe; secrets: string[]; envVars: string[]; paginationNote: string } {
  const { kept, secrets } = cleanHeaders(request.headers);
  let headers = kept;
  let envVars: string[] = [];
  if (opts.redact) {
    const r = redactHeaders(kept);
    headers = r.headers;
    envVars = r.envVars;
  }

  const { pagination, note } = detectPagination(request);
  const format = opts.format ?? "json";
  const rows: Recipe["rows"] =
    format === "html"
      ? { format, selector: "table tr" }
      : { format, path: opts.rowsPath ?? "$" };

  const recipe: Recipe = {
    description: `Harvest of ${request.url}`,
    source: { url: request.url, method: request.method, headers, body: request.bodyText },
    pagination,
    rows,
    politeness: { delayMs: 500, maxRetries: 3 },
    output: { formats: ["csv", "sqlite"], basename: basenameFromUrl(request.url) },
  };
  return { recipe, secrets, envVars, paginationNote: note };
}

const program = new Command();

program
  .name("datasiphon")
  .description("Turn captured browser traffic (HAR or cURL) into clean, reproducible data harvests.")
  .version("0.1.0");

function shortUrl(url: string, max = 80): string {
  return url.length > max ? url.slice(0, max - 1) + "\u2026" : url;
}

program
  .command("inspect")
  .description("Rank the requests in a HAR file to find the one carrying the data.")
  .argument("<file>", "path to a .har file")
  .option("-n, --top <n>", "number of results to show", "10")
  .option("--all", "show every request, including low-scoring ones")
  .action(async (file: string, opts: { top: string; all?: boolean }) => {
    let requests: CapturedRequest[];
    try {
      requests = await parseHarFile(file);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const ranked = rankRequests(requests);
    const shown = opts.all ? ranked : ranked.filter((r) => r.score > 0).slice(0, Number(opts.top));

    if (shown.length === 0) {
      console.log("No promising data requests found. Re-run with --all to see everything.");
      return;
    }

    console.log(`\nFound ${requests.length} requests. Most likely data endpoints:\n`);
    shown.forEach((r, i) => {
      const rows = r.estimatedRows ? `  ~${r.estimatedRows} rows` : "";
      console.log(`  [${i + 1}] ${r.request.method}  ${shortUrl(r.request.url)}`);
      console.log(`      score ${r.score}${rows}`);
      if (r.reasons.length) console.log(`      ${r.reasons.join("; ")}`);
      console.log("");
    });
    console.log('Next: datasiphon init <file.har> --pick <number>\n');
  });

program
  .command("init")
  .description("Generate a recipe.yaml from a captured request (HAR + --pick, or a cURL file).")
  .argument("<file>", "path to a .har or cURL text file")
  .option("--pick <n>", "for HAR input, which ranked request to use (default: top)")
  .option("--probe", "fetch the endpoint once to detect the record path, format, and pagination")
  .option("--no-probe", "never fetch; rely only on the capture")
  .option("--redact", "replace secret header values with ${ENV_VAR} placeholders")
  .option("-o, --out <file>", "output recipe path", "recipe.yaml")
  .action(async (file: string, opts: { pick?: string; probe?: boolean; redact?: boolean; out: string }) => {
    let request: CapturedRequest;
    let rowsPath: string | undefined;
    try {
      if (file.endsWith(".har")) {
        const ranked: RankedRequest[] = rankRequests(await parseHarFile(file));
        const idx = opts.pick ? Number(opts.pick) - 1 : 0;
        const chosen = ranked[idx];
        if (!chosen) {
          console.error(`Error: no request at position ${opts.pick}. Run "inspect" to see options.`);
          process.exitCode = 1;
          return;
        }
        request = chosen.request;
        rowsPath = chosen.rowsPath;
      } else {
        request = await parseCurlFile(file);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    // Probe when asked, or automatically when we have no record path and probing
    // wasn't explicitly disabled (--no-probe sets opts.probe === false).
    const shouldProbe =
      request.method === "GET" && (opts.probe === true || (opts.probe !== false && !rowsPath));
    let format: "json" | "xml" | "html" | undefined;
    if (shouldProbe) {
      try {
        console.log(`Probing ${request.url} ...`);
        const probed = await probeRequest(request);
        for (const note of probed.notes) console.log(`  ${note}`);
        request = probed.request;
        rowsPath = probed.rowsPath ?? rowsPath;
        format = probed.format;
      } catch (err) {
        console.log(`  probe failed (${(err as Error).message}); continuing from the capture.`);
      }
    }

    const { recipe, secrets, envVars, paginationNote } = buildRecipe(request, {
      rowsPath,
      format,
      redact: opts.redact,
    });
    await saveRecipe(opts.out, recipe);

    console.log(`\nWrote ${opts.out}`);
    console.log(`  source:     ${recipe.source.method} ${recipe.source.url}`);
    if (recipe.rows.format === "html") {
      console.log(`  format:     html`);
      console.log(`  selector:   ${recipe.rows.selector}  (guessed; edit to target the right rows)`);
    } else {
      console.log(`  format:     ${recipe.rows.format}`);
      console.log(`  rows.path:  ${recipe.rows.path}${rowsPath ? "" : "  (guessed; verify this)"}`);
    }
    console.log(`  pagination: ${paginationNote}`);
    if (opts.redact && envVars.length) {
      console.log(`\n  Redacted secret headers. Set these before running:`);
      for (const v of envVars) console.log(`    export ${v}='...'`);
    } else if (secrets.length) {
      console.log(`\n  Note: kept sensitive headers (${secrets.join(", ")}). Treat the recipe as a`);
      console.log("  secret, or re-run with --redact to move them to environment variables.");
    }
    console.log(`\nNext: review ${opts.out}, then run: datasiphon run ${opts.out}\n`);
  });

program
  .command("run")
  .description("Execute a recipe.yaml: harvest, paginate, flatten, export.")
  .argument("<recipe>", "path to a recipe.yaml")
  .option("--resume", "continue a previously interrupted harvest")
  .option("--max-pages <n>", "override the recipe's page cap (e.g. for a dry run)")
  .action(async (recipePath: string, opts: { resume?: boolean; maxPages?: string }) => {
    let recipe: Recipe;
    try {
      recipe = await loadRecipe(recipePath);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    try {
      const result = await runHarvest(recipe, {
        resume: opts.resume,
        maxPages: opts.maxPages ? Number(opts.maxPages) : undefined,
        log: (m) => console.log(m),
      });
      console.log(`\nDone: ${result.rows} rows across ${result.pages} page(s).`);
      console.log(`Outputs: ${result.outputs.join(", ")}`);
    } catch (err) {
      console.error(`\nHarvest failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// Allow piping a cURL string in for quick checks: `pbpaste | datasiphon peek`
program
  .command("peek")
  .description("Read a cURL command from stdin and print the normalized request.")
  .action(async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const input = Buffer.concat(chunks).toString("utf8").trim();
    if (!input) {
      console.error("No input on stdin. Pipe a cURL command in.");
      process.exitCode = 1;
      return;
    }
    try {
      const req = parseCurlString(input);
      console.log(JSON.stringify(req, null, 2));
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync();
