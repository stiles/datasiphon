import { writeFile } from "node:fs/promises";
import type { Recipe } from "../recipe.js";

export interface Manifest {
  tool: string;
  version: string;
  generated: string;
  source: { url: string; method: string };
  pagination: string;
  pagesFetched: number;
  rowsCollected: number;
  columns: string[];
  outputs: string[];
  /** Anything that needed human attention during the run. */
  warnings: string[];
}

export async function writeManifest(
  path: string,
  recipe: Recipe,
  stats: {
    pagesFetched: number;
    rowsCollected: number;
    columns: string[];
    outputs: string[];
    warnings: string[];
  },
): Promise<Manifest> {
  const manifest: Manifest = {
    tool: "datasiphon",
    version: "0.1.0",
    generated: new Date().toISOString(),
    source: { url: recipe.source.url, method: recipe.source.method },
    pagination: recipe.pagination.type,
    pagesFetched: stats.pagesFetched,
    rowsCollected: stats.rowsCollected,
    columns: stats.columns,
    outputs: stats.outputs,
    warnings: stats.warnings,
  };
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}
