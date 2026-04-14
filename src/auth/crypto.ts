/**
 * AES-256-GCM column-level encryption for token-at-rest in SQLite.
 *
 * Key is sourced from KRAKEN_TOKEN_ENCRYPTION_KEY env var (hex or base64),
 * parsed once at startup and passed through KrakenConfig.tokenEncryptionKey.
 *
 * Format: iv:ciphertext:authTag (all hex-encoded, colon-separated)
 *   - iv:        12 random bytes per encryption call (24 hex chars)
 *   - ciphertext: variable-length hex string
 *   - authTag:   16-byte GCM authentication tag (32 hex chars)
 *
 * A fresh random IV is generated on every encrypt() call. Never reuse IVs.
 * Tamper detection is enforced by GCM auth tag verification in decrypt().
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

/**
 * Parse a 32-byte encryption key from hex or base64 encoding.
 * Throws if the decoded key is not exactly 32 bytes.
 */
export function parseEncryptionKey(raw: string): Buffer {
  // Try hex first: 64 hex chars = 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Try base64: 44 base64 chars = 32 bytes (with padding)
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `Encryption key must be exactly 32 bytes; got ${buf.length} ` +
        `(input length: ${raw.length} chars). Use 64 hex chars or 44 base64 chars.`,
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * Returns hex-encoded string: iv:ciphertext:authTag
 *   - iv: 12 random bytes (24 hex chars)
 *   - ciphertext: variable length
 *   - authTag: 16 bytes (32 hex chars)
 *
 * A fresh random IV is generated per call. Never reuse IVs.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a ciphertext produced by encrypt().
 *
 * Throws on:
 *   - Malformed ciphertext (wrong number of colon-separated parts)
 *   - Tampered ciphertext (auth tag verification failure)
 *   - Wrong key
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext: expected iv:ciphertext:authTag');
  }
  const [ivHex, dataHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const data = Buffer.from(dataHex!, 'hex');
  const authTag = Buffer.from(tagHex!, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
