export interface StateHandlers {
  enter?(now: number): void;
  update?(now: number, elapsed: number): void;
  exit?(now: number): void;
}

export class StateMachine<S extends string> {
  private currentState: S;
  private enteredAt: number;

  constructor(
    private readonly states: Record<S, StateHandlers>,
    initial: S,
    now: number,
  ) {
    this.currentState = initial;
    this.enteredAt = now;
    states[initial].enter?.(now);
  }

  get current(): S {
    return this.currentState;
  }

  elapsed(now: number): number {
    return now - this.enteredAt;
  }

  transition(next: S, now: number): void {
    if (next === this.currentState) return;
    this.states[this.currentState].exit?.(now);
    this.currentState = next;
    this.enteredAt = now;
    this.states[next].enter?.(now);
  }

  update(now: number): void {
    this.states[this.currentState].update?.(now, now - this.enteredAt);
  }
}
