// App lock: a PIN (stored as a SHA-256 hash) plus an optional device passkey, which iOS unlocks with Face ID.
// This is a convenience lock for the UI; data in IndexedDB is not encrypted.

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
  c => c.charCodeAt(0),
);
const random = n => crypto.getRandomValues(new Uint8Array(n));

export async function hashPin(pin) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('expense-tracker:' + pin));
  return b64url(digest);
}

export async function passkeySupported() {
  try {
    return !!window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function createPasskey() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: random(32),
      rp: { name: 'Expenses' },
      user: { id: random(16), name: 'Expenses app lock', displayName: 'Expenses app lock' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none',
      timeout: 60000,
    },
  });
  return b64url(cred.rawId);
}

export async function verifyPasskey(credId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: fromB64url(credId) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return !!assertion;
}
