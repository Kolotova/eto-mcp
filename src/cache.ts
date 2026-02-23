export class TtlCache<T> {
  private readonly data = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const existing = this.data.get(key);
    if (!existing) {
      return undefined;
    }

    if (Date.now() > existing.expiresAt) {
      this.data.delete(key);
      return undefined;
    }

    return existing.value;
  }

  set(key: string, value: T): void {
    this.data.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
