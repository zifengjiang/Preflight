/** 近期已确认处理过的 deliveryId，用于幂等；LRU 淘汰 */
export class DeliveryIdDeduper {
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly maxSize: number) {}

  isProcessed(deliveryId: string): boolean {
    return deliveryId !== "" && this.seen.has(deliveryId);
  }

  /** 标记为已处理（成功处理路径上调用） */
  markProcessed(deliveryId: string): void {
    if (!deliveryId) return;
    if (this.seen.has(deliveryId)) return;
    this.seen.add(deliveryId);
    this.order.push(deliveryId);
    while (this.order.length > this.maxSize) {
      const evict = this.order.shift();
      if (evict) this.seen.delete(evict);
    }
  }
}
