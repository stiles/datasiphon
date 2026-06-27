/**
 * A single HTTP request captured from the browser, normalized from either a
 * HAR entry or a "Copy as cURL" string. This is the common currency the rest
 * of the tool operates on.
 */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed from the URL's query string for convenience. */
  queryParams: Record<string, string>;
  bodyText?: string;
  /** Present only when the capture came from a HAR (which records responses). */
  response?: CapturedResponse;
}

export interface CapturedResponse {
  status: number;
  contentType?: string;
  /** Lowercased header names mapped to values (for e.g. Link-header pagination). */
  headers?: Record<string, string>;
  bodyText?: string;
}

/**
 * The result of scoring a captured request for how likely it is to be the
 * "hidden API" carrying the data a journalist actually wants.
 */
export interface RankedRequest {
  request: CapturedRequest;
  score: number;
  /** Best-guess number of records in the response, if it looked tabular. */
  estimatedRows: number;
  /** JSONPath-ish pointer to where the record array lives, if found. */
  rowsPath?: string;
  /** Plain-language explanation of why this ranked where it did. */
  reasons: string[];
}
