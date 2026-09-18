import { describe, expect, it } from 'vitest';
import { WorkerRecoveryPolicy } from './WorkerRecoveryPolicy';

describe('WorkerRecoveryPolicy', () => {
  it('reinicia GPU y degrada a CPU tras fallos consecutivos', () => {
    const policy = new WorkerRecoveryPolicy('GPU', 3, [100, 200, 500]);
    expect(policy.failure('gpu 1', false)).toEqual({ delegate: 'GPU', delayMs: 100, fellBack: false });
    expect(policy.failure('gpu 2', false)).toEqual({ delegate: 'GPU', delayMs: 200, fellBack: false });
    expect(policy.failure('gpu 3', false)).toEqual({ delegate: 'CPU', delayMs: 0, fellBack: true });
    expect(policy.fallbackReason).toBe('gpu 3');
  });

  it('no oscila de CPU a GPU después de recuperarse', () => {
    const policy = new WorkerRecoveryPolicy('GPU', 1, [100]);
    policy.failure('timeout', false);
    policy.success();
    expect(policy.delegate).toBe('CPU');
    expect(policy.failure('cpu error', false).delegate).toBe('CPU');
  });

  it('degrada inmediatamente si falla la inicialización GPU', () => {
    const policy = new WorkerRecoveryPolicy('GPU', 5, [100]);
    expect(policy.failure('init', true).delegate).toBe('CPU');
  });
});
