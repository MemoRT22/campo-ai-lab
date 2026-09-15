import type { Delegate } from '../config';

export interface RecoveryDecision {
  delegate: Delegate;
  delayMs: number;
  fellBack: boolean;
}

/** Estado puro del circuito GPU → CPU. CPU queda fijado hasta recargar la sesión. */
export class WorkerRecoveryPolicy {
  delegate: Delegate;
  consecutiveFailures = 0;
  fallbackReason = '';

  private cpuLocked = false;

  constructor(
    preferred: Delegate,
    private readonly threshold: number,
    private readonly retryDelaysMs: number[],
  ) {
    this.delegate = preferred;
  }

  failure(reason: string, duringInit: boolean): RecoveryDecision {
    this.consecutiveFailures++;
    const shouldFallback = this.delegate === 'GPU' && (duringInit || this.consecutiveFailures >= this.threshold);
    if (shouldFallback) {
      this.delegate = 'CPU';
      this.cpuLocked = true;
      this.fallbackReason = reason;
      return { delegate: this.delegate, delayMs: 0, fellBack: true };
    }
    const index = Math.min(this.consecutiveFailures - 1, this.retryDelaysMs.length - 1);
    return { delegate: this.delegate, delayMs: this.retryDelaysMs[index], fellBack: false };
  }

  success(): void {
    this.consecutiveFailures = 0;
    // Intencionalmente no se libera cpuLocked: evita oscilación GPU ↔ CPU.
    if (this.cpuLocked) this.delegate = 'CPU';
  }
}
