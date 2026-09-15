// Public, non-secret install identity. This key is not authentication.
// Generate server-side; issuance and persistence belong to future callers.
export const INSTALL_PUBLIC_KEY_PREFIX = 'cfi_';
export const INSTALL_PUBLIC_KEY_LENGTH = 36;

export function isValidInstallPublicKey(value) {
  return typeof value === 'string'
    && value.length === INSTALL_PUBLIC_KEY_LENGTH
    && /^cfi_[0-9a-f]{32}$/.test(value);
}

export function generateInstallPublicKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return INSTALL_PUBLIC_KEY_PREFIX
    + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
