---
name: np-encryption
description: "Quality bar for any change that encrypts, decrypts, hashes, signs, or verifies data; stores or checks passwords; sets up TLS or certificate handling; generates tokens, nonces, IVs, or salts; or reads, writes, or rotates keys and secrets. Triggered for executor work touching cryptography, password storage, transport security, signing/HMAC, or key/secret management. Encodes crypto rules the change MUST satisfy before commit — not a spec to author. Language- and framework-agnostic."
user-invocable: false
---

# Encryption & Key Management

Crypto code is not done when it round-trips in a test — it is done when it would survive a hostile reviewer. The failure mode is silent: a broken cipher mode, a reused nonce, or a leaked key produces output that looks correct. Apply every relevant section to the diff. A single unaddressed item is a blocking finding, not a nit.

## Before editing

- Read existing crypto conventions / locked decisions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "<query>" --task $TASK_ID`. Reuse the project's chosen library and key store; do not introduce a second.
- Locked decisions in RULES/CONTEXT (cipher, hasher, key source, rotation policy) override every generic default below.

## Never roll your own

- Use the platform's vetted, current high-level crypto library — not raw block-cipher calls, not a hand-built construction. If you are choosing modes, padding, or combining primitives by hand, stop.
- Pick the right tool. Hashing is one-way (integrity, dedup, fingerprints). Encryption is reversible (confidentiality). Signing/HMAC proves authenticity. Do not substitute one for another.

## Hashing & passwords

- Passwords go through a slow, salted password hasher (argon2/bcrypt/scrypt or the project's chosen one) with a per-secret salt. Never MD5/SHA1/plain-SHA256 for passwords.
- General-purpose fast hashes are for integrity/identity only, never for secrets that must resist guessing.

## Encryption

- Use authenticated encryption (AEAD, e.g. AES-GCM / ChaCha20-Poly1305). Never ECB. Never unauthenticated CBC where tampering matters.
- A fresh IV/nonce per message from a CSPRNG. Never a static, zero, or reused IV/nonce — reuse breaks the cipher.
- Encrypt sensitive data in transit: TLS everywhere, verify certificates, no protocol/cipher downgrade, no disabled verification. Encrypt at rest where the threat model requires it.

## Keys, secrets & randomness

- Keys and secrets live in a secret store / KMS / env — NEVER in source, config-in-repo, fixtures, or logs. No key material in error messages or URLs.
- Scope keys to purpose and plan rotation: rotation must not orphan data encrypted under the old key.
- Use a CSPRNG for anything security-relevant — tokens, IVs, salts, session ids. Never a normal/seedable RNG.
- Compare secrets, tokens, MACs, and signatures in constant time. Never `==` on a secret.

## Verification bar (must hold before commit)

- No home-rolled crypto; a vetted current primitive/library is used for the right job (hash vs encrypt vs sign).
- Passwords use a slow salted hasher; no MD5/SHA1 for any secret.
- Encryption is AEAD with a CSPRNG-fresh IV/nonce; no ECB, no static/reused nonce.
- Data is encrypted in transit with verified TLS; at rest where the threat model demands it.
- No key or secret introduced into source, config-in-repo, or logs; rotation and scoping are accounted for.
- All security-relevant randomness is CSPRNG; secret comparisons are constant-time.
- If any item cannot be satisfied within task scope, stop and surface it as a finding — do not commit around it. Pair with [np-secure-code-review] for the sink-level review, [np-secure-design] when the change adds a new key or trust boundary, and [np-data-privacy] when the data is personal/regulated.
