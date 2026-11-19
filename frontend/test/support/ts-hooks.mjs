// Node test loader support: the frontend sources are TypeScript with
// extensionless relative imports (bundler resolution). Node strips types but
// needs explicit specifiers, so this hook appends `.ts` to relative imports
// before handing them back to the default resolver.

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
