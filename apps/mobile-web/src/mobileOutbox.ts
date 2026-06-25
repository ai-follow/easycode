import type { RelayEnvelope } from "@easycode/protocol";

export class MobileOutbox {
  private readonly queueLimit: number;
  private queued: RelayEnvelope[] = [];
  private readonly pending = new Map<string, RelayEnvelope>();

  constructor(queueLimit = 200) {
    this.queueLimit = Number.isInteger(queueLimit) && queueLimit > 0 ? queueLimit : 200;
  }

  get pendingCount(): number {
    return this.queued.length + this.pending.size;
  }

  enqueue(envelope: RelayEnvelope): boolean {
    if (this.hasEnvelope(envelope.id)) return false;
    this.queued.push(envelope);
    this.trimQueue();
    return true;
  }

  trackPending(envelope: RelayEnvelope): void {
    this.pending.set(envelope.id, envelope);
  }

  ack(envelopeId: string): boolean {
    return this.pending.delete(envelopeId);
  }

  reject(envelopeId: string): boolean {
    const deletedPending = this.pending.delete(envelopeId);
    const deletedQueued = this.removeQueued(envelopeId);
    return deletedPending || deletedQueued;
  }

  takeQueued(): RelayEnvelope[] {
    return this.queued.splice(0);
  }

  requeuePending(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const envelope of pending.reverse()) {
      if (this.hasEnvelope(envelope.id)) continue;
      this.queued.unshift(envelope);
    }
    this.trimQueue();
  }

  clear(): void {
    this.queued = [];
    this.pending.clear();
  }

  private removeQueued(envelopeId: string): boolean {
    const lengthBefore = this.queued.length;
    this.queued = this.queued.filter((envelope) => envelope.id !== envelopeId);
    return this.queued.length !== lengthBefore;
  }

  private hasEnvelope(envelopeId: string): boolean {
    return this.pending.has(envelopeId) || this.queued.some((envelope) => envelope.id === envelopeId);
  }

  private trimQueue(): void {
    if (this.queued.length > this.queueLimit) {
      this.queued.splice(0, this.queued.length - this.queueLimit);
    }
  }
}
