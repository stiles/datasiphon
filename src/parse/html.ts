import { parse as parseHtml, type HTMLElement } from "node-html-parser";

export interface HtmlRowsSpec {
  /** CSS selector for the repeating row element (e.g. "table tbody tr"). */
  selector: string;
  /** Optional named columns, each a CSS selector evaluated within a row. */
  fields?: Record<string, string>;
}

/**
 * Extract records from an HTML document.
 * - With `fields`, each record is { name: text } using per-field selectors.
 * - Without `fields`, falls back to table semantics: each <td>/<th> becomes
 *   c1, c2, ...; if a row has no cells, its text becomes { text }.
 */
export function extractHtmlRows(html: string, spec: HtmlRowsSpec): Record<string, string>[] {
  const root = parseHtml(html);
  const rows = root.querySelectorAll(spec.selector);
  const records: Record<string, string>[] = [];

  for (const row of rows) {
    if (spec.fields && Object.keys(spec.fields).length) {
      const record: Record<string, string> = {};
      for (const [name, sel] of Object.entries(spec.fields)) {
        const el = row.querySelector(sel);
        record[name] = el ? el.text.trim() : "";
      }
      records.push(record);
      continue;
    }

    const cells = row.querySelectorAll("td, th");
    if (cells.length) {
      const record: Record<string, string> = {};
      cells.forEach((c, i) => {
        record[`c${i + 1}`] = c.text.trim();
      });
      records.push(record);
    } else {
      records.push({ text: row.text.trim() });
    }
  }
  return records;
}

export interface RowSuggestion {
  /** Suggested CSS selector for the repeating row. */
  selector: string;
  /** Header-derived column map, when the table exposes a clean header row. */
  fields?: Record<string, string>;
  /** How many rows the selector matched in the probed page. */
  rowCount: number;
  /** Plain-language note about how the guess was made. */
  note: string;
}

/** First class on an element, if any (used to build a stable-ish selector). */
function firstClass(el: HTMLElement): string | undefined {
  const cls = el.getAttribute("class");
  if (!cls) return undefined;
  const c = cls.trim().split(/\s+/)[0];
  return c || undefined;
}

/** A selector that targets a specific table by id or first class, else `table`. */
function tablePrefix(table: HTMLElement): string {
  const id = table.getAttribute("id");
  if (id) return `#${id}`;
  const cls = firstClass(table);
  return cls ? `table.${cls}` : "table";
}

/** Turn a header label into a safe-ish column name. */
function fieldName(label: string, index: number): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || `c${index + 1}`;
}

/** Read a table's header labels from <thead> th, or a leading th row. */
function headerLabels(table: HTMLElement): string[] {
  const theadCells = table.querySelectorAll("thead th");
  if (theadCells.length) return theadCells.map((c) => c.text.trim());
  const firstRow = table.querySelector("tr");
  const ths = firstRow?.querySelectorAll("th") ?? [];
  return ths.map((c) => c.text.trim());
}

function tableSuggestion(table: HTMLElement, rowCount: number): RowSuggestion {
  const prefix = tablePrefix(table);
  const hasTbody = !!table.querySelector("tbody");
  const selector = hasTbody ? `${prefix} tbody tr` : `${prefix} tr`;

  // Only map header -> fields when we can cleanly separate the header from the
  // data rows (i.e. there is a <tbody>), otherwise the header row would leak in.
  let fields: Record<string, string> | undefined;
  let note = `largest <table> has ${rowCount} data rows`;
  if (hasTbody) {
    const labels = headerLabels(table);
    if (labels.length >= 2 && labels.every((l) => l.length > 0)) {
      fields = {};
      const seen = new Set<string>();
      labels.forEach((label, i) => {
        let name = fieldName(label, i);
        while (seen.has(name)) name = `${name}_${i + 1}`;
        seen.add(name);
        fields![name] = `td:nth-child(${i + 1})`;
      });
      note += `; mapped ${labels.length} header columns to fields`;
    }
  }
  return { selector, fields, rowCount, note };
}

/** Find the most common repeated sibling element when there's no usable table. */
function repeatedElementSuggestion(root: HTMLElement): RowSuggestion | undefined {
  const counts = new Map<string, { selector: string; count: number }>();
  for (const el of root.querySelectorAll("*")) {
    const tag = el.rawTagName?.toLowerCase();
    if (!tag || /^(html|head|body|script|style|br|table|thead|tbody|tr|td|th)$/.test(tag)) continue;
    const cls = firstClass(el);
    if (!cls) continue; // a bare div/span is too generic to suggest
    const selector = `${tag}.${cls}`;
    const entry = counts.get(selector) ?? { selector, count: 0 };
    entry.count++;
    counts.set(selector, entry);
  }
  let best: { selector: string; count: number } | undefined;
  for (const entry of counts.values()) {
    if (entry.count >= 3 && (!best || entry.count > best.count)) best = entry;
  }
  if (!best) return undefined;
  return {
    selector: best.selector,
    rowCount: best.count,
    note: `no data table found; "${best.selector}" repeats ${best.count} times`,
  };
}

/**
 * Suggest a CSS selector for the repeating row in an HTML page. Prefers the
 * largest data table (and maps its header to named fields when it has a
 * <tbody>); otherwise falls back to the most-repeated classed element.
 */
export function suggestHtmlRows(html: string): RowSuggestion | undefined {
  const root = parseHtml(html);

  let best: { table: HTMLElement; count: number } | undefined;
  for (const table of root.querySelectorAll("table")) {
    const tbody = table.querySelector("tbody");
    const scope = tbody ?? table;
    const dataRows = scope.querySelectorAll("tr").filter((tr) => tr.querySelectorAll("td").length > 0);
    if (dataRows.length >= 2 && (!best || dataRows.length > best.count)) {
      best = { table, count: dataRows.length };
    }
  }
  if (best) return tableSuggestion(best.table, best.count);

  return repeatedElementSuggestion(root);
}
