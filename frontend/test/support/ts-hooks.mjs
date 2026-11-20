// Node test loader support for the frontend TypeScript sources.
//
// The frontend sources use extensionless relative imports (bundler resolution).
// Node strips types but needs explicit specifiers, so this hook appends `.ts`
// before handing a relative specifier back to the default resolver.

export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !specifier.endsWith('.ts') &&
    !specifier.endsWith('.json')
  ) {
    try {
      return await next(`${specifier}.ts`, context)
    } catch {
      // Fall through to the default resolution for real `.js`/directory hits.
    }
  }
  return next(specifier, context)
}