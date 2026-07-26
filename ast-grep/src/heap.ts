export class BoundedMaxHeap<T> {
  readonly #capacity: number;
  readonly #compare: (left: T, right: T) => number;
  readonly #items: T[] = [];

  constructor(capacity: number, compare: (left: T, right: T) => number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("bounded heap capacity must be a positive safe integer.");
    }
    this.#capacity = capacity;
    this.#compare = compare;
  }

  get size(): number {
    return this.#items.length;
  }

  push(candidate: T): void {
    if (this.#items.length < this.#capacity) {
      this.#items.push(candidate);
      this.#bubbleUp(this.#items.length - 1);
      return;
    }
    if (this.#compare(candidate, this.#items[0]!) >= 0) {
      return;
    }
    this.#items[0] = candidate;
    this.#bubbleDown(0);
  }

  toSortedArray(): T[] {
    return [...this.#items].sort(this.#compare);
  }

  #bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#compare(this.#items[parent]!, this.#items[index]!) >= 0) {
        break;
      }
      [this.#items[parent], this.#items[index]] = [this.#items[index]!, this.#items[parent]!];
      index = parent;
    }
  }

  #bubbleDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.#items.length && this.#compare(this.#items[left]!, this.#items[largest]!) > 0) {
        largest = left;
      }
      if (right < this.#items.length && this.#compare(this.#items[right]!, this.#items[largest]!) > 0) {
        largest = right;
      }
      if (largest === index) {
        return;
      }
      [this.#items[index], this.#items[largest]] = [this.#items[largest]!, this.#items[index]!];
      index = largest;
    }
  }
}
