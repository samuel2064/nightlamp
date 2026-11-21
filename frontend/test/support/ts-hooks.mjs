// Node test loader support for the frontend TypeScript sources.
//
// The repository's Node 20 baseline cannot strip types natively, so this hook
// transpiles `.ts` sources with the `typescript` package that ships in the
// frontend devDependencies. It also resolves the `@/` path alias and the
// extensionless relative imports the bundler-style sources use, so the same
// lane runs on Node 20 and newer.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolvePath(here, '..', '..', 'src')

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = join(srcRoot, specifier.slice(2))
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        return next(pathToFileURL(candidate).href, context)
      }
    }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-z]+$/.test(specifier)
  ) {
    for (const suffix of ['.ts', '.tsx']) {
      try {
        return await next(`${specifier}${suffix}`, context)
      } catch {
        // Try the next suffix, then fall through to the default resolver.
      }
    }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        // JSX only for .tsx: with it on, a generic arrow like `async <T>(...)`
        // in a plain .ts file would be parsed as JSX.
        jsx: url.endsWith('.tsx') ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
      },
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return next(url, context)
}
