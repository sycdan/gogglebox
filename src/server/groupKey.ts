import crypto from 'node:crypto';

// Fixed namespace UUID for Gogglebox viewer groups. UUIDv5 derives a stable id
// by hashing this namespace together with the name (our sorted user-id list),
// so the same set of people always maps to the same key regardless of order.
const GROUP_NAMESPACE = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function uuidv5(name: string, namespace: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(uuidToBytes(namespace));
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);

  // Set the version (5) and RFC 4122 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Derive a deterministic, order-independent group key from a set of viewer ids.
// Ids are de-duplicated and sorted, joined, hashed via UUIDv5, dashes stripped.
export function deriveGroupKey(viewerIds: string[]): string {
  const sorted = [...new Set(viewerIds)].sort();
  return uuidv5(sorted.join(','), GROUP_NAMESPACE).replace(/-/g, '');
}
