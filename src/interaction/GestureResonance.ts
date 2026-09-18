const MAX_PENDING = 8;

export interface ResonancePartner {
  personId: number;
  x: number;
  y: number;
}

/**
 * Detecta ONE_HAND_UP casi simultáneos de dos personas distintas. Cada onda sólo puede resonar una
 * vez: al encontrar pareja ambas se consumen. Usa los personId temporales; ids negativos se ignoran.
 */
export class GestureResonance {
  private readonly personId = new Int32Array(MAX_PENDING).fill(-1);
  private readonly at = new Float64Array(MAX_PENDING);
  private readonly x = new Float32Array(MAX_PENDING);
  private readonly y = new Float32Array(MAX_PENDING);
  private readonly partner: ResonancePartner = { personId: -1, x: 0, y: 0 };

  constructor(private readonly windowMs: number) {}

  /**
   * Registra la onda de una persona (px CSS). Devuelve la onda compañera más reciente de otra
   * persona dentro de la ventana, o null. El objeto devuelto se reutiliza entre llamadas.
   */
  register(personId: number, x: number, y: number, now: number): ResonancePartner | null {
    if (personId < 0) return null;
    let best = -1;
    let free = -1;
    let oldest = 0;
    for (let i = 0; i < MAX_PENDING; i++) {
      const expired = this.personId[i] < 0 || now - this.at[i] > this.windowMs;
      if (expired) {
        this.personId[i] = -1;
        if (free < 0) free = i;
        continue;
      }
      if (this.personId[i] === personId) {
        // Una segunda onda de la misma persona reemplaza a la anterior.
        this.personId[i] = -1;
        if (free < 0) free = i;
        continue;
      }
      if (best < 0 || this.at[i] > this.at[best]) best = i;
      if (this.at[i] < this.at[oldest]) oldest = i;
    }

    if (best >= 0) {
      this.partner.personId = this.personId[best];
      this.partner.x = this.x[best];
      this.partner.y = this.y[best];
      this.personId[best] = -1;
      return this.partner;
    }

    const slot = free >= 0 ? free : oldest;
    this.personId[slot] = personId;
    this.at[slot] = now;
    this.x[slot] = x;
    this.y[slot] = y;
    return null;
  }
}
