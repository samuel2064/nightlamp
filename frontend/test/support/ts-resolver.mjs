// Entry point for `node --import ./test/support/ts-resolver.mjs`.

import { register } from 'node:module'

register('./ts-hooks.mjs', import.meta.url)