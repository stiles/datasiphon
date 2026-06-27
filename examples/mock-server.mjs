// Tiny paginated API for testing datasiphon end to end, with no network.
//   node examples/mock-server.mjs   # serves on http://localhost:8787
import { createServer } from "node:http";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const FACILITIES = [
  { id: 1, facility: "Acme Diner", score: 92, date: "2026-01-04", inspector: { id: 7, name: "Lopez" } },
  { id: 2, facility: "Bayside Cafe", score: 78, date: "2026-01-05", inspector: { id: 7, name: "Lopez" } },
  { id: 3, facility: "Corner Deli", score: 88, date: "2026-01-06", inspector: { id: 3, name: "Ng" } },
  { id: 4, facility: "Dock Street Grill", score: 64, date: "2026-01-07", inspector: { id: 3, name: "Ng" } },
  { id: 5, facility: "Eastside Bakery", score: 99, date: "2026-01-08", inspector: { id: 9, name: "Park" } },
];

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const limit = Number(url.searchParams.get("per_page") ?? 2);

  // Offset pagination (?offset=&per_page=)
  if (url.pathname === "/api/v1/inspections") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const page = FACILITIES.slice(offset, offset + limit);
    return json(res, 200, { meta: { total: FACILITIES.length, offset, per_page: limit }, results: page });
  }

  // Link-header pagination (?page=)
  if (url.pathname === "/api/v1/linkheader") {
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * limit;
    const slice = FACILITIES.slice(start, start + limit);
    const headers = {};
    if (start + limit < FACILITIES.length) {
      headers["link"] = `<http://localhost:${PORT}/api/v1/linkheader?page=${page + 1}&per_page=${limit}>; rel="next"`;
    }
    return json(res, 200, { results: slice }, headers);
  }

  // Cursor / next-field pagination (?cursor=)
  if (url.pathname === "/api/v1/cursor") {
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const slice = FACILITIES.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < FACILITIES.length ? String(cursor + limit) : null;
    return json(res, 200, { results: slice, paging: { next: nextCursor } });
  }

  // XML response
  if (url.pathname === "/api/v1/xml") {
    const rows = FACILITIES.map(
      (f) =>
        `    <record><id>${f.id}</id><facility>${f.facility}</facility><score>${f.score}</score><date>${f.date}</date></record>`,
    ).join("\n");
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(`<?xml version="1.0"?>\n<records>\n${rows}\n</records>\n`);
  }

  // HTML table
  if (url.pathname === "/api/v1/html") {
    const rows = FACILITIES.map(
      (f) => `<tr><td>${f.id}</td><td>${f.facility}</td><td>${f.score}</td><td>${f.date}</td></tr>`,
    ).join("");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><body><table><tbody>${rows}</tbody></table></body></html>`);
  }

  // Auth-protected endpoint (tests env-var header substitution)
  if (url.pathname === "/api/v1/secure") {
    if (req.headers.authorization !== "Bearer secret-token") {
      return json(res, 401, { error: "unauthorized" });
    }
    return json(res, 200, { results: FACILITIES.slice(0, 2) });
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`mock API on http://localhost:${PORT}`);
  console.log("  /api/v1/inspections  offset pagination (?offset=&per_page=)");
  console.log("  /api/v1/linkheader   Link-header pagination (?page=)");
  console.log("  /api/v1/cursor       next-field cursor pagination (?cursor=)");
  console.log("  /api/v1/xml          XML records");
  console.log("  /api/v1/html         HTML table");
  console.log("  /api/v1/secure       requires Authorization: Bearer secret-token");
});
