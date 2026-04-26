import { randomBytes } from 'node:crypto';

export function generateClientId(label: string): string {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'client';
  const suffix = randomBytes(4).toString('hex');
  return `${safeLabel}-${suffix}`;
}
