// Node test loader support: the frontend sources are TypeScript with
// extensionless relative imports and the `@/` path alias (bundler resolution).
// Node strips types but needs explicit specifiers, so this hook appends `.ts`
// to relative imports and rewrites `@/` onto the frontend `src/` directory
// before handing them back to the default resolver.

const SRC_ROOT = new URL('../../src/', import.meta.url)

async function resolveWithExtension(specifier, context, next) {
  try {
    return await next(`${specifier}.ts`, context)
  } catch {
    // Fall through to the default resolution for real `.js`/directory hits.
  }
  return next(specifier, context)
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    // The alias is a bundler-ism: map it onto frontend/src and keep the
    // resolved specifier a file URL so the default loader accepts it.
    const mapped = new URL(specifier.slice(2), SRC_ROOT)
    if (!mapped.pathname.endsWith('.ts')) {
      try {
        return await next(`${mapped.href}.ts`, context)
      } catch {
        // Fall through to the default resolution for directory hits.
      }
    }
    return next(mapped.href, context)
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !specifier.endsWith('.ts') &&
    !specifier.endsWith('.json')
  ) {
    return resolveWithExtension(specifier, context, next)
  }
  return next(specifier, context)
}