export const STATES = [
  "new",
  "triaged",
  "approved",
  "in-progress",
  "in-review",
  "needs-human",
  "merged",
  "deployed",
] as const;
export type State = (typeof STATES)[number];
export type Actor =
  "triage" | "command" | "implement" | "review" | "fix" | "gate" | "github" | "deploy";

const PREFIX = "factory:";

// spec 4.2. merged는 PR 병합 이벤트(github)만, deployed는 배포 단계(deploy)만 만든다.
const ALLOWED: ReadonlyArray<readonly [State, State, readonly Actor[]]> = [
  ["new", "triaged", ["triage"]],
  ["new", "approved", ["command"]],
  ["new", "needs-human", ["triage", "command"]],
  ["triaged", "approved", ["command"]],
  ["triaged", "needs-human", ["command"]],
  ["needs-human", "approved", ["command"]],
  ["approved", "in-progress", ["implement"]],
  ["approved", "needs-human", ["implement", "command"]],
  ["in-progress", "in-review", ["implement", "fix"]],
  ["in-progress", "needs-human", ["implement", "fix", "command"]],
  ["in-review", "in-progress", ["fix"]],
  ["in-review", "needs-human", ["review", "fix", "gate", "command"]],
  ["in-review", "merged", ["github"]],
  ["needs-human", "merged", ["github"]],
  ["merged", "deployed", ["deploy"]],
  ["merged", "needs-human", ["deploy"]],
];

export function stateLabel(s: State): string {
  return `${PREFIX}${s}`;
}

export function isState(v: string): v is State {
  return (STATES as readonly string[]).includes(v);
}

export class TransitionError extends Error {
  readonly from: State;
  readonly to: State;
  readonly actor: Actor;
  constructor(from: State, to: State, actor: Actor) {
    super(`transition ${from} → ${to} is not allowed for ${actor}`);
    this.name = "TransitionError";
    this.from = from;
    this.to = to;
    this.actor = actor;
  }
}

export function canTransition(from: State, to: State, actor: Actor): boolean {
  return ALLOWED.some(([f, t, actors]) => f === from && t === to && actors.includes(actor));
}

export function transition(from: State, to: State, actor: Actor): State {
  if (!canTransition(from, to, actor)) throw new TransitionError(from, to, actor);
  return to;
}

export interface LabelState {
  state: State;
  stale: State[];
}

export function stateFromLabels(labels: string[]): LabelState {
  const states = labels
    .filter((l) => l.startsWith(PREFIX))
    .map((l) => l.slice(PREFIX.length))
    .filter(isState);
  if (states.length === 0) return { state: "new", stale: [] };
  if (states.length === 1) return { state: states[0]!, stale: [] };
  if (states.includes("approved")) {
    const others = states.filter((s) => s !== "approved");
    if (others.every((s) => canTransition(s, "approved", "command"))) {
      return { state: "approved", stale: others };
    }
  }
  throw new Error(`conflicting factory state labels: ${states.join(", ")}`);
}
