// Capture one or more pages of a public API into a HAR fixture (with response
// bodies), approximating a browser's "Save all as HAR with content". Use it to
// regenerate the committed fixtures, or to make new ones for testing.
//
// Usage:
//   node examples/capture.mjs --url "<url>" --out name [options]
//
// Options:
//   --out <name>            output file: examples/<name>.har (required)
//   --pages <n>             number of pages to fetch (default 1)
//   --offset-param <name>   query param to advance by --limit each page
//   --limit <n>             page size used with --offset-param (default 5)
//   --header "K: V"         extra request header (repeatable)
//
// Example (Socrata, NYC 311):
//   node examples/capture.mjs \
//     --url 'https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=5&$offset=0' \
//     --out socrata_nyc311 --pages 2 --offset-param '$offset' --limit 5
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function parseArgs(argv) {
  const args = { pages: 1, limit: 5, headers: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--pages") args.pages = Number(argv[++i]);
    else if (a === "--offset-param") args.offsetParam = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--header") {
      const h = argv[++i];
      const idx = h.indexOf(":");
      if (idx > 0) args.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
  }
  return args;
}

function toHarHeaders(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    console.error("Required: --url and --out. See header comment for usage.");
    process.exit(1);
  }

  const reqHeaders = { Accept: "application/json", ...args.headers };
  const entries = [];

  for (let page = 0; page < args.pages; page++) {
    const url = new URL(args.url);
    if (args.offsetParam) url.searchParams.set(args.offsetParam, String(page * args.limit));
    const finalUrl = url.toString();

    console.log(`Fetching page ${page + 1}/${args.pages}: ${finalUrl}`);
    const startedDateTime = new Date().toISOString();
    const res = await fetch(finalUrl, { headers: reqHeaders });
    const text = await res.text();

    const respHeaders = [];
    res.headers.forEach((value, name) => respHeaders.push({ name, value }));

    entries.push({
      startedDateTime,
      request: {
        method: "GET",
        url: finalUrl,
        headers: toHarHeaders(reqHeaders),
        queryString: [...url.searchParams.entries()].map(([name, value]) => ({ name, value })),
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        headers: respHeaders,
        content: {
          size: text.length,
          mimeType: res.headers.get("content-type") ?? "application/json",
          text,
        },
      },
    });
  }

  const har = {
    log: {
      version: "1.2",
      creator: { name: "datasiphon capture.mjs", version: "0.1.0" },
      entries,
    },
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, `${args.out}.har`);
  await writeFile(outPath, JSON.stringify(har, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath} (${entries.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
