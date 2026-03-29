import type { TokenUsage } from '../types.js';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function numberField(
  obj: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = obj?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function addNumber<K extends keyof TokenUsage>(
  usage: TokenUsage,
  key: K,
  value: number | undefined,
): void {
  if (typeof value === 'number') {
    usage[key] = value;
  }
}
