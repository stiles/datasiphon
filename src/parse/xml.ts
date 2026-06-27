import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep repeated elements as arrays even when only one is present, so that
  // rows.path can reliably point at a record array.
  isArray: () => false,
  trimValues: true,
});

/** Parse an XML document into a plain JS object usable with resolvePath. */
export function parseXml(text: string): unknown {
  return parser.parse(text);
}
