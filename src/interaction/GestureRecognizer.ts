import type { Config } from '../config';
import { expAlpha } from '../utils/MathUtils';
import type { PersonInfo, PoseInfo, PoseLandmark } from '../vision/types';
import type { GestureEvent, GesturePoint, GestureType } from './GestureEvents';

const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const MATCH_DISTANCE = 0.25;

interface ArmState {
  up: boolean;
  wristX: number;
  wristY: number;
  shoulderY: number;
  confidence: number;
}

interface EdgeState {
  armed: boolean;
  candidateAt: number;
}

interface PoseTrack {
  id: number;
  cx: number;
  cy: number;
  lastSeen: number;
  left: ArmState;
  right: ArmState;
  one: EdgeState;
  both: EdgeState;
}

function newArm(): ArmState {
  return { up: false, wristX: 0, wristY: 0, shoulderY: 0, confidence: 0 };
}

function newEdge(): EdgeState {
  return { armed: true, candidateAt: -1 };
}

/** Pose landmarks → eventos por flanco. No conoce narrativa, partículas ni UI. */
export class GestureRecognizer {
  currentGesture: GestureType | 'NONE' = 'NONE';

  private tracks: PoseTrack[] = [];
  private nextId = 1;

  constructor(private readonly settings: Config['gestures']) {}

  update(poses: PoseInfo[], people: PersonInfo[], now: number): GestureEvent[] {
    this.tracks = this.tracks.filter((track) => now - track.lastSeen <= this.settings.absenceGraceMs);
    const events: GestureEvent[] = [];
    const available = new Set(this.tracks.map((track) => track.id));
    let anyOne = false;
    let anyBoth = false;

    for (const pose of poses) {
      if (pose.landmarks.length <= RIGHT_WRIST) continue;
      const center = poseCenter(pose.landmarks);
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) continue;
      let track = this.closestTrack(center.x, center.y, available);
      if (!track) {
        track = {
          id: this.nextId++, cx: center.x, cy: center.y, lastSeen: now,
          left: newArm(), right: newArm(), one: newEdge(), both: newEdge(),
        };
        this.tracks.push(track);
      }
      available.delete(track.id);
      const dt = Math.max(0, now - track.lastSeen);
      track.lastSeen = now;
      track.cx = center.x;
      track.cy = center.y;

      const alpha = expAlpha(dt || 33, this.settings.smoothingMs);
      const leftValid = this.updateArm(track.left, pose.landmarks[LEFT_WRIST], pose.landmarks[LEFT_SHOULDER], alpha);
      const rightValid = this.updateArm(track.right, pose.landmarks[RIGHT_WRIST], pose.landmarks[RIGHT_SHOULDER], alpha);
      if (!leftValid && !rightValid) continue;
      // Una caída breve de confianza conserva el flanco, pero nunca madura un gesto con un punto obsoleto.
      if ((!leftValid && track.left.up) || (!rightValid && track.right.up)) continue;

      const oneUp = track.left.up || track.right.up;
      const bothUp = track.left.up && track.right.up;
      anyOne ||= oneUp;
      anyBoth ||= bothUp;

      // ONE sólo madura con exactamente una mano. Si ambas suben juntas, se prioriza BOTH.
      if (!oneUp) this.rearm(track.one);
      else if (!bothUp) this.maybeTrigger(track, track.one, 'ONE_HAND_UP', this.settings.oneHandHoldMs, people, now, events);
      else track.one.candidateAt = -1;

      if (!bothUp) this.rearm(track.both);
      else this.maybeTrigger(track, track.both, 'BOTH_HANDS_UP', this.settings.bothHandsHoldMs, people, now, events);
    }

    this.currentGesture = anyBoth ? 'BOTH_HANDS_UP' : anyOne ? 'ONE_HAND_UP' : 'NONE';
    return events;
  }

  reset(): void {
    this.tracks = [];
    this.currentGesture = 'NONE';
  }

  private updateArm(arm: ArmState, wrist: PoseLandmark, shoulder: PoseLandmark, alpha: number): boolean {
    const confidence = Math.min(wrist.visibility, shoulder.visibility);
    if (![wrist.x, wrist.y, shoulder.y, confidence].every(Number.isFinite) || confidence < this.settings.minVisibility) return false;
    if (arm.confidence === 0) {
      arm.wristX = wrist.x;
      arm.wristY = wrist.y;
      arm.shoulderY = shoulder.y;
    } else {
      arm.wristX += (wrist.x - arm.wristX) * alpha;
      arm.wristY += (wrist.y - arm.wristY) * alpha;
      arm.shoulderY += (shoulder.y - arm.shoulderY) * alpha;
    }
    arm.confidence = confidence;
    const margin = arm.up ? this.settings.lowerMargin : this.settings.raiseMargin;
    arm.up = arm.wristY < arm.shoulderY - margin;
    return true;
  }

  private maybeTrigger(
    track: PoseTrack,
    edge: EdgeState,
    type: GestureType,
    holdMs: number,
    people: PersonInfo[],
    now: number,
    events: GestureEvent[],
  ): void {
    if (!edge.armed) return;
    if (edge.candidateAt < 0) edge.candidateAt = now;
    if (now - edge.candidateAt < holdMs) return;
    edge.armed = false;
    edge.candidateAt = -1;
    const points: GesturePoint[] = [];
    if (track.left.up) points.push({ x: track.left.wristX, y: track.left.wristY });
    if (track.right.up) points.push({ x: track.right.wristX, y: track.right.wristY });
    const confidences = [track.left, track.right].filter((arm) => arm.up).map((arm) => arm.confidence);
    events.push({
      type,
      personId: closestPersonId(track.cx, track.cy, people),
      points,
      timestamp: now,
      confidence: Math.min(...confidences),
      source: 'pose',
    });
  }

  private rearm(edge: EdgeState): void {
    edge.armed = true;
    edge.candidateAt = -1;
  }

  private closestTrack(x: number, y: number, available: Set<number>): PoseTrack | null {
    let best: PoseTrack | null = null;
    let distance = MATCH_DISTANCE;
    for (const track of this.tracks) {
      if (!available.has(track.id)) continue;
      const d = Math.hypot(x - track.cx, y - track.cy);
      if (d < distance) {
        distance = d;
        best = track;
      }
    }
    return best;
  }
}

function poseCenter(landmarks: PoseLandmark[]): GesturePoint {
  const left = landmarks[LEFT_SHOULDER];
  const right = landmarks[RIGHT_SHOULDER];
  return { x: (left.x + right.x) * 0.5, y: (left.y + right.y) * 0.5 };
}

function closestPersonId(x: number, y: number, people: PersonInfo[]): number {
  let id = -1;
  let best = Infinity;
  for (const person of people) {
    if (!person.confirmed) continue;
    const distance = Math.hypot(x - person.cx, y - person.cy);
    if (distance < best) {
      best = distance;
      id = person.id;
    }
  }
  return id;
}
