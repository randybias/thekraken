/**
 * Loads CHROMA_SCENARIOS from the sibling tentacular-chroma checkout.
 *
 * The two repos sit in ~/code/tentacular-main/ and are pinned together
 * via lockstep tags. Importing a sibling's test file via relative path
 * is acceptable for this test framework.
 *
 * On import failure (sibling not checked out, etc.), returns an empty
 * array with a warning so thekraken can build standalone.
 *
 * Spec: docs/superpowers/specs/2026-05-07-chroma-e2e-platform-tests-design.md
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ChromaScenarioDef {
  id: string;
  name: string;
  chromaPath: string;
  expectRedirect?: RegExp;
  expectText?: Array<string | RegExp>;
  forbiddenText?: Array<string | RegExp>;
  timeoutMs?: number;
  unauthenticated?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// thekraken/test/e2e-chroma/load-chroma-scenarios.ts
// HERE = tentacular-main/thekraken/test/e2e-chroma
// ../../../ = tentacular-main/
// ../../../tentacular-chroma = tentacular-main/tentacular-chroma
const DEFAULT_SIBLING = resolve(HERE, '../../../tentacular-chroma');

export interface LoadChromaScenariosOpts {
  /**
   * Override the sibling tentacular-chroma checkout path. Default
   * resolves relative to this file's location.
   */
  siblingPath?: string;
}

export async function loadChromaScenarios(
  opts: LoadChromaScenariosOpts = {},
): Promise<ChromaScenarioDef[]> {
  const siblingPath = opts.siblingPath ?? DEFAULT_SIBLING;
  const scenariosPath = resolve(siblingPath, 'test/e2e/scenarios.ts');
  if (!existsSync(scenariosPath)) {
    console.warn(
      `[chroma-loader] scenarios not found at ${scenariosPath}; returning empty array`,
    );
    return [];
  }
  try {
    // Use file:// URL so dynamic import works under both Node ESM and tsx.
    const mod = (await import(pathToFileURL(scenariosPath).href)) as {
      CHROMA_SCENARIOS?: ChromaScenarioDef[];
    };
    return mod.CHROMA_SCENARIOS ?? [];
  } catch (err) {
    console.warn(
      `[chroma-loader] failed to import ${scenariosPath}: ${(err as Error).message}`,
    );
    return [];
  }
}
