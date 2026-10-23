import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { InvalidArgumentError } from "../errors.js";
import { assertPath, assertRev, GIT_ENV_ISOLATION, Git, type Trailer } from "../git/git.js";

const run = promisify(execFile);

/** A throwaway repository whose git commands never see the developer's config or an outer repo. */
export interface TempRepo {
  /** The work-tree root, or the git directory for a bare repo. */
  readonly root: string;
  readonly git: Git;
  /**
   * The hermetic environment the repo's git runs with: identity, an empty global config, no
   * system config, and the `GIT_*` locating variables set to `undefined`. Merge it over
   * `process.env` (dropping `undefined` values) to spawn a tool on the repo, for example from
   * inside a git hook, without leaking the outer repository.
   */
  readonly env: NodeJS.ProcessEnv;
  write(path: string, content: string | Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Writes every file of a path → content map, for example a `logFixtureFiles` result. */
  writeFiles(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  stage(...paths: string[]): Promise<void>;
  /** Commits the index (with `all`, every tracked change first); returns the sha. */
  commit(
    message: string,
    o?: {
      readonly trailers?: readonly Trailer[];
      readonly all?: boolean;
      readonly allowEmpty?: boolean;
    },
  ): Promise<string>;
  checkout(ref: string, o?: { readonly create?: boolean }): Promise<void>;
  /** Merges `ref` into the current branch; returns the new HEAD sha. */
  merge(ref: string, o?: { readonly noFf?: boolean; readonly message?: string }): Promise<string>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface TempRepoOptions {
  /** Default `"main"`. */
  readonly initialBranch?: string;
  readonly objectFormat?: "sha1" | "sha256";
  /** A bare repository (`git.root === null`); populate it by pushing to it. */
  readonly bare?: boolean;
  /** Written and committed as the first commit. */
  readonly files?: Readonly<Record<string, string>>;
  /** Fixed author and committer dates, read at each commit. */
  readonly clock?: () => Date;
}

export async function createTempRepo(o: TempRepoOptions = {}): Promise<TempRepo> {
  const branch = o.initialBranch ?? "main";
  assertRev(branch);
  if (o.bare === true && o.files !== undefined) {
    throw new InvalidArgumentError("a bare temp repo can't be created with files");
  }
  if (o.bare === true && o.objectFormat !== undefined) {
    throw new InvalidArgumentError("a bare temp repo can't set objectFormat");
  }
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ledger-")));
  const globalConfig = join(tmp, ".gitconfig");
  await writeFile(globalConfig, "");
  const env: NodeJS.ProcessEnv = Object.freeze({
    ...GIT_ENV_ISOLATION,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    HOME: tmp,
    GIT_AUTHOR_NAME: "Ledger Test",
    GIT_AUTHOR_EMAIL: "ledger-test@example.com",
    GIT_COMMITTER_NAME: "Ledger Test",
    GIT_COMMITTER_EMAIL: "ledger-test@example.com",
  });
  const dispose = () => rm(tmp, { recursive: true, force: true });

  try {
    let git: Git;
    let root: string;
    if (o.bare === true) {
      root = join(tmp, "repo.git");
      git = await Git.initBare(root, { env });
      await git.run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    } else {
      root = join(tmp, "repo");
      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...env })) {
        if (v !== undefined) spawnEnv[k] = v;
      }
      const format = o.objectFormat === undefined ? [] : [`--object-format=${o.objectFormat}`];
      await run("git", ["init", "-q", "-b", branch, ...format, "--", root], { env: spawnEnv });
      git = await Git.open(root, { env });
    }
    await git.run(["config", "commit.gpgsign", "false"]);
    const repo = tempRepo(root, git, env, o.clock, dispose);
    if (o.files !== undefined) {
      await repo.writeFiles(o.files);
      await repo.stage(...Object.keys(o.files));
      await repo.commit("initial");
    }
    return repo;
  } catch (e) {
    await dispose();
    throw e;
  }
}

function tempRepo(
  root: string,
  git: Git,
  env: NodeJS.ProcessEnv,
  clock: (() => Date) | undefined,
  dispose: () => Promise<void>,
): TempRepo {
  const workTree = (path?: string): string => {
    if (git.root === null) throw new InvalidArgumentError("operation needs a work tree");
    if (path !== undefined) assertPath(path);
    return git.root;
  };
  /** A `Git` whose commits carry the clock's date, or the repo's own `Git`. */
  const committer = async (): Promise<Git> => {
    if (clock === undefined) return git;
    const date = clock().toISOString();
    return Git.open(workTree(), {
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  const head = async (): Promise<string> => {
    const sha = await git.resolveCommit("HEAD");
    if (sha === null) throw new InvalidArgumentError("HEAD does not resolve");
    return sha;
  };

  const write = async (path: string, content: string | Uint8Array): Promise<void> => {
    const full = join(workTree(path), path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  return {
    root,
    git,
    env,
    write,
    async writeFiles(files) {
      workTree();
      for (const [path, content] of Object.entries(files)) await write(path, content);
    },
    async remove(path) {
      await rm(join(workTree(path), path), { recursive: true, force: true });
    },
    async stage(...paths) {
      workTree();
      await git.add(paths);
    },
    async commit(message, o = {}) {
      workTree();
      if (o.all === true) await git.run(["add", "-u"]);
      const c = await committer();
      return c.commit({
        message,
        ...(o.trailers === undefined ? {} : { trailers: o.trailers }),
        ...(o.allowEmpty === undefined ? {} : { allowEmpty: o.allowEmpty }),
      });
    },
    async checkout(ref, o = {}) {
      workTree();
      assertRev(ref);
      await git.run(["checkout", "-q", ...(o.create === true ? ["-b"] : []), ref, "--"]);
    },
    async merge(ref, o = {}) {
      workTree();
      assertRev(ref);
      const c = await committer();
      await c.run([
        "merge",
        "-q",
        ...(o.noFf === true ? ["--no-ff"] : []),
        "-m",
        o.message ?? `merge ${ref}`,
        "--end-of-options",
        ref,
      ]);
      return head();
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
