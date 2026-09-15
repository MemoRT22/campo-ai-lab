/** Máximo de siluetas simultáneas que pueden llegar desde TargetField. */
export const FORMATION_SLOTS = 8;

/**
 * Coreografía de formación por persona: anticipación → colapso → lock.
 *
 * Cada track temporal (`personId`) recibe su propio inicio de formación, así una segunda persona
 * que llega también tiene su entrada. El lock es irreversible mientras el track exista: cuando la
 * mayor parte del cuerpo ya se formó, la silueta pasa al perfil espejo y no vuelve a lo cinematográfico.
 * No es identidad persistente: un id que desaparece libera su lugar.
 */
export class FormationTracker {
  /** Lugar interno de cada persona según su índice en TargetField (válido tras `sync`). */
  readonly slotOfPerson = new Int8Array(FORMATION_SLOTS).fill(-1);

  private readonly ids = new Int32Array(FORMATION_SLOTS).fill(-1);
  private readonly startAt = new Float64Array(FORMATION_SLOTS);
  private readonly lockedAt = new Float64Array(FORMATION_SLOTS).fill(-1);
  private readonly progress = new Float32Array(FORMATION_SLOTS);
  private readonly seen = new Uint8Array(FORMATION_SLOTS);

  /** Asocia los tracks presentes a lugares; los ids nuevos empiezan su formación en `now`. */
  sync(ids: ArrayLike<number>, count: number, now: number): void {
    const n = Math.min(count, FORMATION_SLOTS);
    this.seen.fill(0);
    this.slotOfPerson.fill(-1);
    for (let k = 0; k < n; k++) {
      for (let s = 0; s < FORMATION_SLOTS; s++) {
        if (this.ids[s] !== ids[k] || this.seen[s] === 1) continue;
        this.slotOfPerson[k] = s;
        this.seen[s] = 1;
        break;
      }
    }
    // Los lugares de ids ausentes se liberan antes de asignar los nuevos.
    for (let s = 0; s < FORMATION_SLOTS; s++) {
      if (this.seen[s] === 0) this.ids[s] = -1;
    }
    for (let k = 0; k < n; k++) {
      if (this.slotOfPerson[k] >= 0) continue;
      for (let s = 0; s < FORMATION_SLOTS; s++) {
        if (this.ids[s] >= 0) continue;
        this.ids[s] = ids[k];
        this.startAt[s] = now;
        this.lockedAt[s] = -1;
        this.progress[s] = 0;
        this.seen[s] = 1;
        this.slotOfPerson[k] = s;
        break;
      }
    }
  }

  /** Tiempo desde que empezó la formación de la persona `k`; Infinity si no está sincronizada. */
  ageOf(k: number, now: number): number {
    const s = this.slotOfPerson[k];
    return s >= 0 ? now - this.startAt[s] : Infinity;
  }

  isLocked(k: number): boolean {
    const s = this.slotOfPerson[k];
    return s >= 0 && this.lockedAt[s] >= 0;
  }

  /** Momento del lock de la persona `k`; -1 si aún no se fija. */
  lockedAtOf(k: number): number {
    const s = this.slotOfPerson[k];
    return s >= 0 ? this.lockedAt[s] : -1;
  }

  progressOf(k: number): number {
    const s = this.slotOfPerson[k];
    return s >= 0 ? this.progress[s] : 0;
  }

  /** Registra cuántas partículas del cuerpo ya están formadas y fija la silueta al cruzar el umbral. */
  report(k: number, formed: number, total: number, now: number, lockThreshold: number): void {
    const s = this.slotOfPerson[k];
    if (s < 0 || total <= 0) return;
    const value = formed / total;
    this.progress[s] = this.lockedAt[s] >= 0 ? Math.max(this.progress[s], value) : value;
    if (this.lockedAt[s] < 0 && value >= lockThreshold) this.lockedAt[s] = now;
  }

  /** Progreso de la persona menos formada que aún no se fija; 1 si todas están fijas o no hay nadie. */
  overallProgress(count: number): number {
    let result = 1;
    for (let k = 0; k < Math.min(count, FORMATION_SLOTS); k++) {
      const s = this.slotOfPerson[k];
      if (s >= 0 && this.lockedAt[s] < 0) result = Math.min(result, this.progress[s]);
    }
    return result;
  }
}
