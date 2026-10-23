/** Display numbers of a log's subjects, assigned on the main ref (design D7). */
export interface Numbering {
  readonly available: boolean;
  readonly reason: "shallow" | "no-main-ref" | null;
  /** Full ref name used, for example `refs/remotes/origin/main`. */
  readonly ref: string | null;
  readonly commit: string | null;
  readonly byId: ReadonlyMap<string, number>;
  readonly byNumber: ReadonlyMap<number, string>;
}

/** No numbers: `available: false`, `reason: "no-main-ref"`, empty maps. */
export const NO_NUMBERING: Numbering = Object.freeze({
  available: false,
  reason: "no-main-ref",
  ref: null,
  commit: null,
  byId: new Map<string, number>(),
  byNumber: new Map<number, string>(),
});
