/**
 * A deliberately tiny JSONPath subset: enough to point at a record array or a
 * pagination token inside a response. Supports `$`, `.key`, `["key"]`, and
 * `[index]`. Not a general JSONPath engine.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path || path === "$") return root;

  const tokens = tokenizePath(path);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

function tokenizePath(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  // Skip a leading "$".
  if (path[i] === "$") i++;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      let key = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") key += path[i++];
      if (key) tokens.push(key);
    } else if (ch === "[") {
      i++;
      if (path[i] === '"' || path[i] === "'") {
        const quote = path[i++];
        let key = "";
        while (i < path.length && path[i] !== quote) key += path[i++];
        i++; // closing quote
        if (path[i] === "]") i++;
        tokens.push(key);
      } else {
        let num = "";
        while (i < path.length && path[i] !== "]") num += path[i++];
        i++; // closing bracket
        tokens.push(Number(num));
      }
    } else {
      // Leading bare key (no dot), e.g. "results"
      let key = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") key += path[i++];
      if (key) tokens.push(key);
    }
  }
  return tokens;
}
