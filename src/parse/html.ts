import { parse as parseHtml } from "node-html-parser";

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
