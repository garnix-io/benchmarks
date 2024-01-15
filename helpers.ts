import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import * as fs from "https://deno.land/std@0.211.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.211.0/path/mod.ts";

let nonce = Date.now();
const getNonce = () => ++nonce;

const innerFlakeSchema = z.object({
  "x86_64-linux": z.record(z.object({ name: z.string() })),
});
const flakeSchema = z.object({
  apps: innerFlakeSchema.optional(),
  checks: innerFlakeSchema.optional(),
  devShells: innerFlakeSchema.optional(),
  packages: innerFlakeSchema.optional(),
});

export const singular = {
  apps: "app",
  checks: "check",
  devShells: "devShell",
  packages: "package",
};

export const findDerivations = (cwd: string) => {
  const flakeJson = runCommand(
    "nix",
    ["flake", "show", "--allow-import-from-derivation", "--json"],
    cwd,
  );
  const flake = flakeSchema.parse(JSON.parse(flakeJson));
  const collect = (group: keyof typeof flake) => {
    const systems = flake[group];
    if (!systems) return [];
    return Object.keys(systems["x86_64-linux"]).map(
      (n) => [group, "x86_64-linux", n] as const,
    );
  };
  return [
    ...collect("apps"),
    ...collect("checks"),
    ...collect("devShells"),
    ...collect("packages"),
  ];
};

export const mkBenchmarkStrategy = (args: {
  name: string;
  pushRepo: string;
  setup: (args: {
    cwd: string;
    nonce: number;
  }) => Promise<{ waitFor: Array<string> }>;
  teardown?: () => Promise<void>;
}) => ({
  name: args.name,
  run: async (repoName: string, cwd: string, commit: string) => {
    const nonce = getNonce();
    const branchName = `test-run-${nonce}`;
    let pushedBranch = false;
    try {
      console.log(
        `==== Benchmarking ${commit} on ${args.pushRepo} branch ${branchName} ====`,
      );
      console.log("Cleaning repo...");
      runCommand("git", ["reset", "--hard", commit], cwd);
      runCommand("git", ["clean", "-dfx"], cwd);
      fs.emptyDirSync(path.join(cwd, ".github"));
      console.log("Setting up...");
      const { waitFor } = await args.setup({ cwd, nonce });
      console.log("Pushing...");
      runCommand("git", ["add", "."], cwd);
      runCommand(
        "git",
        ["commit", "-m", `Set up ${repoName} for ${args.pushRepo}`],
        cwd,
      );
      const updatedSha = runCommand("git", ["rev-parse", "HEAD"], cwd).trim();
      runCommand(
        "git",
        ["remote", "set-url", "origin", `git@github.com:${args.pushRepo}.git`],
        cwd,
      );
      runCommand("git", ["fetch", "origin"], cwd);
      runCommand(
        "git",
        ["push", "origin", `${updatedSha}:refs/heads/${branchName}`],
        cwd,
      );
      pushedBranch = true;
      console.log("Checking timings...");
      const timings = await getCheckTimings({
        repo: args.pushRepo,
        commit: updatedSha,
        waitFor,
      });
      await args.teardown?.();
      return { ...timings, branchName };
    } catch (err) {
      return { fail: err.toString(), branchName };
    } finally {
      if (pushedBranch) {
        runCommand("git", ["push", "origin", `:${branchName}`], cwd);
      }
    }
  },
});

export const withTempCopy = async <T>(
  srcDir: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const tmpDir = await Deno.makeTempDir();
  await fs.copy(srcDir, tmpDir, { overwrite: true });
  try {
    return await fn(tmpDir);
  } catch (err) {
    throw err;
  } finally {
    await fs.emptyDir(tmpDir);
    await Deno.remove(tmpDir);
  }
};

export const getLastNCommits = (repoDir: string, numCommits: number) => {
  return runCommand(
    "git",
    ["log", `--max-count=${numCommits}`, "--pretty=format:%H"],
    repoDir,
  )
    .trim()
    .split("\n")
    .reverse();
};

export const runCommand = (
  command: string,
  args: Array<string>,
  cwd?: string,
): string => {
  const output = new Deno.Command(command, {
    args,
    cwd,
    stderr: "inherit",
  }).outputSync();
  if (output.code !== 0) {
    throw new Error(
      `exit-code ${output.code} from: ${command} ${args.join(" ")}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
};

export const writeYml = (cwd: string, filePath: string, data: object) => {
  Deno.writeTextFileSync(
    path.join(cwd, filePath),
    JSON.stringify(data, null, 2),
  );
};

export const writeNixGithubActionsYml = (
  cwd: string,
  checkSteps: Record<
    string,
    readonly ({ run: string } | { uses: string; with: object })[]
  >,
) => {
  fs.emptyDirSync(path.join(cwd, ".github/workflows"));
  writeYml(cwd, ".github/workflows/nix.yml", {
    name: "Nix on github",
    on: { push: {} },
    jobs: mapValues(
      (steps) => ({
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: "actions/checkout@v3" },
          {
            uses: "nixbuild/nix-quick-install-action@v19",
            with: {
              nix_conf: "experimental-features = nix-command flakes",
            },
          },
          ...steps,
        ],
      }),
      checkSteps,
    ),
  });
};

export const mapValues = <Obj extends Record<string, unknown>, FnResult>(
  f: (i: Obj[keyof Obj], key: keyof Obj) => FnResult,
  x: Obj,
): { [key in keyof Obj]: FnResult } => {
  const result: Partial<{ [key in keyof Obj]: FnResult }> = {};
  for (const [key, value] of Object.entries(x) as Array<
    [keyof Obj, Obj[keyof Obj]]
  >) {
    result[key] = f(value, key);
  }
  return result as { [key in keyof Obj]: FnResult };
};

const getCheckTimings = async (args: {
  repo: string;
  commit: string;
  waitFor: Array<string>;
}) => {
  let lastLog = "";
  const log = (msg: string) => {
    if (lastLog !== msg) console.log(msg);
    lastLog = msg;
  };
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 30000));
    const checkSuite = await getCheckSuite(args);
    log(`status: ${checkSuite?.status}`);
    if (checkSuite == null) continue;
    if (checkSuite.status !== "completed") continue;
    if (checkSuite.conclusion !== "success") {
      throw new Error(`check suite has conclusion ${checkSuite.conclusion}.`);
    }
    const checkRuns = await getCheckRuns({
      repo: args.repo,
      checkSuiteId: checkSuite.id,
    });
    if (checkRuns.check_runs.some((x) => x.completed_at == null)) continue;
    const allChecksDone = args.waitFor.every((checkName) => {
      if (!checkRuns.check_runs.some((x) => x.name == checkName)) {
        log(
          `Waiting for ${checkName} (found ${checkRuns.check_runs
            .map((x) => x.name)
            .join()})`,
        );
        return false;
      }
      return true;
    });
    if (!allChecksDone) continue;
    const completed_at = Math.max(
      ...checkRuns.check_runs.map((checkRun) => {
        return new Date(checkRun.completed_at!).valueOf();
      }),
    );
    return {
      time: completed_at - new Date(checkSuite.created_at).valueOf(),
    };
  }
};

const getCheckSuite = async (args: {
  repo: string;
  commit: string;
}): Promise<null | z.infer<typeof checkSuiteSchema>> => {
  const checkSuites = await fetchFromGithub(
    `/repos/${args.repo}/commits/${args.commit}/check-suites`,
    checkSuitesSchema,
  );
  const checkSuites_tmp = checkSuites.check_suites.filter(
    (checkSuite) =>
      checkSuite.head_sha.startsWith(args.commit) &&
      checkSuite.latest_check_runs_count > 0,
  );
  if (checkSuites_tmp.length === 0) {
    return null;
  }
  if (checkSuites_tmp.length > 1) {
    throw new Error("multiple check-suites found");
  }
  return checkSuites_tmp[0];
};

const checkSuiteSchema = z.object({
  id: z.number(),
  created_at: z.string().datetime(),
  head_sha: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "startup_failure",
      "stale",
    ])
    .nullable(),
  latest_check_runs_count: z.number(),
});

const checkSuitesSchema = z.object({
  check_suites: z.array(checkSuiteSchema),
});

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      completed_at: z.string().datetime().nullable(),
    }),
  ),
});

const getCheckRuns = (args: {
  repo: string;
  checkSuiteId: number;
}): Promise<z.infer<typeof checkRunsSchema>> => {
  return fetchFromGithub(
    `/repos/${args.repo}/check-suites/${args.checkSuiteId}/check-runs`,
    checkRunsSchema,
  );
};

const fetchFromGithub = async <T>(
  url: string,
  schema: z.Schema<T>,
): Promise<T> => {
  let json: string;
  while (true) {
    try {
      json = runCommand("gh", ["api", url]);
      break;
    } catch (err) {
      console.log("Error from gh api (retrying in 10 seconds):", err);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
  return schema.parse(JSON.parse(json));
};

export const getBenchmarkedDataDirs = (): Array<string> => {
  const result = [];
  for (const org of [...Deno.readDirSync("data")]) {
    const dir = Deno.readDirSync("data/" + org.name);
    for (const repo of [...dir]) result.push(`data/${org.name}/${repo.name}`);
  }
  return result.sort();
};

export const collectCommitBenchmarks = (): Array<Array<string>> => {
  const allStrategies = new Set<string>();
  const allRepos = new Set<string>();
  const timesByCommitByStrategyByRepo: Record<
    string,
    Record<string, Record<string, number>>
  > = {};
  for (const repo of getBenchmarkedDataDirs()) {
    allRepos.add(repo);
    timesByCommitByStrategyByRepo[repo] ||= {};
    const strategies = [...Deno.readDirSync(repo)].map((dir) => dir.name);
    for (const strategy of strategies) {
      allStrategies.add(strategy);
      timesByCommitByStrategyByRepo[repo][strategy] ||= {};
      const commits = [...Deno.readDirSync(`${repo}/${strategy}`)].map(
        (dir) => dir.name,
      );
      for (const commit of commits) {
        const data = JSON.parse(
          Deno.readTextFileSync(`${repo}/${strategy}/${commit}`),
        );
        timesByCommitByStrategyByRepo[repo][strategy][commit] = data.time;
      }
    }
  }
  const strategies = [...allStrategies.values()].sort();
  const repos = [...allRepos.values()].sort();
  const results: Array<Array<string>> = [["Repo", "Commit", ...strategies]];
  for (const repo of repos) {
    const allCommits = new Set<string>();
    for (const strategy of strategies) {
      for (const commit in timesByCommitByStrategyByRepo[repo][strategy]) {
        allCommits.add(commit);
      }
    }
    for (const commit of [...allCommits].sort()) {
      results.push([
        repo,
        commit.match(/\d{4}_([0-9a-f]{40})\.json/)![1],
        ...strategies.map((strategy) => {
          const ms = timesByCommitByStrategyByRepo[repo]?.[strategy]?.[commit];
          if (!ms) return "";
          return (ms / 1000).toString();
        }),
      ]);
    }
  }
  return results;
};

export const getArgs = () => {
  const args = z.union([
    z.tuple([z.literal("benchmark"), z.string()]),
    z.tuple([z.literal("compileData")]),
  ]);
  return args.parse(Deno.args);
};
