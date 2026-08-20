/**
 * Let Node resolve the app's extensionless imports.
 *
 * Vite resolves `./chain` to `./chain.ts` for us, so the source omits extensions, which is
 * idiomatic and should stay. Node's ESM resolver requires them. Rather than rewrite hundreds
 * of imports to suit a test runner, this hook does the same resolution Vite does, which keeps
 * the tests exercising exactly the code that ships.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !path.extname(specifier)) {
    const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const base = path.resolve(parent, specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
