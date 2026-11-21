/**
 * Minimal typed event emitter (browsers have no `events` module). Mirrors the parts of
 * Node's EventEmitter API that the Node package's helpers expose: on, once, off, emit, listeners.
 */
export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly handlers = new Map<keyof Events, Array<(...args: never[]) => unknown>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => unknown): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (...args: never[]) => unknown);
    this.handlers.set(event, list);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => unknown): this {
    const wrapper = (...args: Events[K]) => {
      this.off(event, wrapper);
      return listener(...args);
    };
    return this.on(event, wrapper);
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => unknown): this {
    const list = this.handlers.get(event);
    const i = list?.indexOf(listener as (...args: never[]) => unknown) ?? -1;
    if (i >= 0) list!.splice(i, 1);
    return this;
  }

  listeners<K extends keyof Events>(event: K): Array<(...args: Events[K]) => unknown> {
    return [...((this.handlers.get(event) ?? []) as Array<(...args: Events[K]) => unknown>)];
  }

  /** Calls the listeners synchronously; a throwing listener does not stop the others. */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const list = this.listeners(event);
    for (const l of list) {
      try {
        l(...args);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
    return list.length > 0;
  }
}
