export interface SharedCaptureLease<T> {
  resource: T;
  release: () => void;
}

interface SharedCaptureEntry<T> {
  resource: T;
  references: number;
}

type InvalidateResource = () => boolean;

/**
 * Shares one physical capture resource between independent logical sessions.
 * The resource is disposed only after the last lease is released.
 */
export class SharedCapturePool<T> {
  private readonly entries = new Map<string, SharedCaptureEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  public constructor(
    private readonly dispose: (resource: T) => void,
    private readonly onResourceCreated?: (
      key: string,
      resource: T,
      invalidate: InvalidateResource
    ) => void
  ) {}

  public async acquire(key: string, create: () => Promise<T>): Promise<SharedCaptureLease<T>> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.references += 1;
      return this.createLease(key, existing.resource);
    }

    let pending = this.pending.get(key);
    if (!pending) {
      pending = Promise.resolve().then(create);
      this.pending.set(key, pending);
    }

    let resource: T;
    try {
      resource = await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }

    const current = this.entries.get(key);
    if (current) {
      if (current.resource !== resource) this.dispose(resource);
      current.references += 1;
      return this.createLease(key, current.resource);
    }

    this.entries.set(key, { resource, references: 1 });
    const invalidate = (): boolean => this.invalidate(key, resource);
    this.onResourceCreated?.(key, resource, invalidate);
    return this.createLease(key, resource);
  }

  public invalidate(key: string, resource: T): boolean {
    const current = this.entries.get(key);
    if (!current || current.resource !== resource) return false;
    this.entries.delete(key);
    this.dispose(resource);
    return true;
  }

  public clear(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.dispose(entry.resource);
  }

  public getReferenceCount(key: string): number {
    return this.entries.get(key)?.references ?? 0;
  }

  private createLease(key: string, resource: T): SharedCaptureLease<T> {
    let released = false;
    return {
      resource,
      release: (): void => {
        if (released) return;
        released = true;
        const current = this.entries.get(key);
        if (!current || current.resource !== resource) return;
        current.references -= 1;
        if (current.references > 0) return;
        this.entries.delete(key);
        this.dispose(resource);
      }
    };
  }
}
