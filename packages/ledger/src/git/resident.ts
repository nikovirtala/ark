import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { type Resident, residentStarted, type SpawnSpec } from "./operation.js";

/** A long-lived process failed, or was asked after its input ended; rerun the call one-shot. */
export class ResidentGone extends Error {
  constructor() {
    super("resident git process is gone");
    this.name = "ResidentGone";
  }
}

/** One `cat-file --batch` answer: an object, or `null` for `missing`, `ambiguous` and the like. */
export interface CatObject {
  readonly oid: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

const OBJECT_HEADER = /^([0-9a-f]+) (\S+) (\d+)$/;

/** Parses `cat-file --batch` output as it arrives: one result per header. */
export class CatFileParser {
  #buf: Buffer = Buffer.alloc(0);

  /** Adds `chunk`; returns the results it completes. */
  push(chunk: Uint8Array): (CatObject | null)[] {
    this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk]);
    const out: (CatObject | null)[] = [];
    let pos = 0;
    for (;;) {
      const eol = this.#buf.indexOf(0x0a, pos);
      if (eol < 0) break;
      const m = OBJECT_HEADER.exec(this.#buf.subarray(pos, eol).toString("utf8"));
      if (m === null) {
        out.push(null);
        pos = eol + 1;
        continue;
      }
      const size = Number(m[3]);
      if (this.#buf.length < eol + 1 + size + 1) break;
      const bytes = new Uint8Array(this.#buf.subarray(eol + 1, eol + 1 + size));
      out.push({ oid: m[1] ?? "", type: m[2] ?? "", bytes });
      pos = eol + 1 + size + 1;
    }
    this.#buf = this.#buf.subarray(pos);
    return out;
  }

  /**
   * At end of output: an object whose header arrived but whose content was cut short, with the
   * bytes that did arrive, or nothing. Only the one-shot path uses it, as it always has.
   */
  end(): CatObject[] {
    const eol = this.#buf.indexOf(0x0a);
    if (eol < 0) return [];
    const m = OBJECT_HEADER.exec(this.#buf.subarray(0, eol).toString("utf8"));
    if (m === null) return [];
    const bytes = new Uint8Array(this.#buf.subarray(eol + 1, eol + 1 + Number(m[3])));
    this.#buf = Buffer.alloc(0);
    return [{ oid: m[1] ?? "", type: m[2] ?? "", bytes }];
  }
}

interface Pending<A> {
  readonly n: number;
  readonly results: A[];
  readonly resolve: (r: A[]) => void;
  readonly reject: (e: unknown) => void;
}

/** How long an ended process may take to exit before it is killed. */
const KILL_AFTER_MS = 5000;

/**
 * A long-lived git process that answers one result per input line, in the order the lines were
 * written. Subclasses parse stdout into results.
 */
abstract class LineProcess<A> implements Resident {
  readonly exited: Promise<void>;
  readonly #child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly #pending: Pending<A>[] = [];
  #ended = false;
  #gone = false;
  #killTimer: NodeJS.Timeout | undefined;

  protected constructor(spec: SpawnSpec) {
    this.#child = spawn(spec.binary, [...spec.argv], {
      cwd: spec.cwd,
      // A user's GIT_FLUSH=0 would hold answers back until the process exits.
      env: { ...spec.env, GIT_FLUSH: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.#child;
    let exit = () => {};
    this.exited = new Promise((res) => {
      exit = res;
    });
    residentStarted(this.exited);
    const gone = () => {
      clearTimeout(this.#killTimer);
      this.#gone = true;
      for (const p of this.#pending.splice(0)) p.reject(new ResidentGone());
      exit();
    };
    child.stdout.on("data", (b: Buffer) => this.#answer(this.parse(b)));
    // Warnings (ambiguous names) would otherwise fill the pipe and stall the process.
    child.stderr.resume();
    // A process that exits closes the pipe; `close` reports it.
    child.stdin.on("error", () => {});
    child.on("error", gone);
    child.on("close", gone);
  }

  /** The results `chunk` of stdout completes. */
  protected abstract parse(chunk: Uint8Array): A[];

  /** Sends `lines`, which must not contain line breaks; one result per line. */
  protected request(lines: readonly string[]): Promise<A[]> {
    if (this.#ended || this.#gone) return Promise.reject(new ResidentGone());
    if (lines.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.#pending.push({ n: lines.length, results: [], resolve, reject });
      this.#child.stdin.write(`${lines.join("\n")}\n`);
    });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#child.stdin.end();
    if (!this.#gone) this.#killTimer = setTimeout(() => this.#child.kill("SIGKILL"), KILL_AFTER_MS);
  }

  #answer(results: A[]): void {
    for (const r of results) {
      const head = this.#pending[0];
      if (head === undefined) return;
      head.results.push(r);
      if (head.results.length === head.n) {
        this.#pending.shift();
        head.resolve(head.results);
      }
    }
  }
}

/** A resident `cat-file --batch`: requests are answered in the order they were written. */
export class CatFileProcess extends LineProcess<CatObject | null> {
  readonly #parser = new CatFileParser();

  /** Starts `spec`, whose argv ends in `cat-file --batch`. */
  static start(spec: SpawnSpec): CatFileProcess {
    return new CatFileProcess(spec);
  }

  /** Looks up `specs`, which must not contain `\r` or `\n`. */
  read(specs: readonly string[]): Promise<(CatObject | null)[]> {
    return this.request(specs);
  }

  protected parse(chunk: Uint8Array): (CatObject | null)[] {
    return this.#parser.push(chunk);
  }
}

/**
 * A resident `hash-object --stdin-paths`: one oid line per path. A path it can't read makes it
 * exit, which rejects the request with `ResidentGone`.
 */
export class HashObjectProcess extends LineProcess<string> {
  #buf = "";

  /** Starts `spec`, whose argv ends in `hash-object --stdin-paths`. */
  static start(spec: SpawnSpec): HashObjectProcess {
    return new HashObjectProcess(spec);
  }

  /** The blob oids of `paths` (relative to the spec's cwd), which must not contain `\n`. */
  hash(paths: readonly string[]): Promise<string[]> {
    return this.request(paths);
  }

  protected parse(chunk: Uint8Array): string[] {
    const lines = (this.#buf + Buffer.from(chunk).toString("utf8")).split("\n");
    this.#buf = lines.pop() ?? "";
    return lines;
  }
}
