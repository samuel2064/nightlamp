// One response_id per intended submission. A retry reuses the same key; a new
// intended submission always gets a fresh key.

const RESPONSE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

export function generateResponseId(random: () => string = defaultRandom): string {
  const raw = random()
  // Backend accepts [A-Za-z0-9._:-]{1,200}; normalize anything exotic out.
  const safe = raw.replace(/[^A-Za-z0-9._:-]/g, '')
  return safe.length > 0 ? safe.slice(0, 200) : fallbackId()
}

function defaultRandom(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  return fallbackId()
}

function fallbackId(): string {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function isValidResponseId(value: string): boolean {
  return RESPONSE_ID_PATTERN.test(value)
}
