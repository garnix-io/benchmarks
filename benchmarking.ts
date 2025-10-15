#!/usr/bin/env -S deno run --check --allow-run --allow-read --allow-write --no-prompt

import {
  collectCommitBenchmarks,
  findDerivations,
  getArgs,
  getLastNCommits,
  mkBenchmarkStrategy,
  runCommand,
  singular,
  withTempCopy,
  writeNixGithubActionsYml,
  writeYml,
} from "./helpers.ts";
import { pad } from "https://deno.land/std@0.36.0/strings/pad.ts";
import * as fs from "https://deno.land/std@0.211.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.211.0/path/mod.ts";

const benchmarkGarnix = mkBenchmarkStrategy({
  name: "garnix",
  pushRepo: "garnix-io/benchmark-garnix",
  async setup({ cwd }) {
    writeYml(cwd, "garnix.yaml", {
      builds: {
        include: findDerivations(cwd).map((d) => d.join(".")),
        exclude: [],
      },
    });
    return {
      waitFor: findDerivations(cwd).map(
        ([group, system, name]) => `${singular[group]} ${name} [${system}]`,
      ),
    };
  },
});

const benchmarkGithubActionsSerial = mkBenchmarkStrategy({
  name: "github-actions-serial",
  pushRepo: "garnix-io/benchmark-github",
  async setup({ cwd, nonce }) {
    const checkName = `gh-actions-serial-${nonce}`;
    writeNixGithubActionsYml(cwd, {
      [checkName]: [
        ...findDerivations(cwd).map((derivation) => ({
          run: `nix build .#${derivation.join(".")}`,
        })),
      ],
    });
    return { waitFor: [checkName] };
  },
});

const benchmarkGithubActionsParallel = mkBenchmarkStrategy({
  name: "github-actions-parallel",
  pushRepo: "garnix-io/benchmark-github",
  async setup({ cwd, nonce }) {
    const checks = findDerivations(cwd).map(
      ([group, system, name]) =>
        [
          `gh-actions-parallel-${nonce}-${group}-${system}-${name}`,
          [
            {
              run: `nix build .#${group}.${system}.${name}`,
            },
          ],
        ] as const,
    );
    writeNixGithubActionsYml(cwd, Object.fromEntries(checks));
    return { waitFor: checks.map(([name]) => name) };
  },
});

const benchmarkNixbuildNet = mkBenchmarkStrategy({
  name: "nixbuild-net",
  pushRepo: "garnix-io/benchmark-github",
  async setup({ cwd, nonce }) {
    const checkName = `nixbuild-net-${nonce}`;
    fs.emptyDirSync(path.join(cwd, ".github/workflows"));
    writeYml(cwd, ".github/workflows/nix.yml", {
      name: "Nix on github",
      on: { push: {} },
      jobs: {
        [checkName]: {
           uses: "nixbuild/nixbuild-action/.github/workflows/ci-workflow.yml@v23",
           secrets: {
             nixbuild_token: "${{ secrets.NIXBUILD_NET_TOKEN }}",
           },
           with: {
             filter_builds:
               findDerivations(cwd).map(([group, system, name]) =>
                 `(.top_attr == "${group}" and .system == "${system}" and .attr == "${name}")`
               ).join(" or ")
           }
        }
      },
    });
    return { waitFor: [`${checkName} / Summary`] };
  }
});

const cachixStep = () => {
  return {
    uses: "cachix/cachix-action@v11",
    with: { name: "benchmark", authtoken: "${{ secrets.CACHIX_AUTH_TOKEN }}" },
  };
};

const benchmarkGithubActionsCachixSerial = mkBenchmarkStrategy({
  name: "github-actions-cachix-serial",
  pushRepo: "garnix-io/benchmark-github",
  async setup({ cwd, nonce }) {
    const checkName = `gh-actions-cachix-serial-${nonce}`;
    writeNixGithubActionsYml(cwd, {
      [checkName]: [
        cachixStep(),
        ...findDerivations(cwd).map((derivation) => ({
          run: `nix build .#${derivation.join(".")}`,
        })),
      ],
    });
    return { waitFor: [checkName] };
  },
});

const benchmarkGithubActionsCachixParallel = mkBenchmarkStrategy({
  name: "github-actions-cachix-parallel",
  pushRepo: "garnix-io/benchmark-github",
  async setup({ cwd, nonce }) {
    const checks = findDerivations(cwd).map(
      ([group, system, name]) =>
        [
          `gh-actions-parallel-${nonce}-${group}-${system}-${name}`,
          [
            cachixStep(),
            {
              run: `nix build .#${group}.${system}.${name}`,
            },
          ],
        ] as const,
    );
    writeNixGithubActionsYml(cwd, Object.fromEntries(checks));
    return { waitFor: checks.map(([name]) => name) };
  },
});

const allStrategies = [
  // benchmarkGarnix,
  // benchmarkGithubActionsSerial,
  // benchmarkGithubActionsParallel,
  benchmarkNixbuildNet,
  // benchmarkGithubActionsCachixSerial,
  // benchmarkGithubActionsCachixParallel,
];

const runBenchmark = async (
  repoName: string,
  repoPath: string,
  benchmarkStrategy: ReturnType<typeof mkBenchmarkStrategy>,
) => {
  const commitsToTest = getLastNCommits(repoPath, 20);
  for (let idx = 0; idx < commitsToTest.length; idx++) {
    const commitSha = commitsToTest[idx];
    const success = await withTempCopy(repoPath, async (tmpDir) => {
      const outPath = `data/${repoName}/${benchmarkStrategy.name}/${pad(
        idx.toString(),
        4,
        { char: "0" },
      )}_${commitSha}.json`;
      if (
        fs.existsSync(outPath) &&
        "time" in JSON.parse(Deno.readTextFileSync(outPath))
      ) {
        console.log(`${outPath} already exists. Skipping...`);
        return true;
      }
      Deno.mkdirSync(path.dirname(outPath), { recursive: true });
      const result = await benchmarkStrategy.run(repoName, tmpDir, commitSha);
      Deno.writeTextFileSync(outPath, JSON.stringify(result));
      return "time" in result && result.time > 0;
    });
    if (!success) {
      console.log(`${repoName} failed, breaking`);
      break;
    }
  }
};

const runAllBenchmarks = async (githubRepo: string) => {
  const cloneDir = await Deno.makeTempDir();
  runCommand("git", [
    "clone",
    `https://github.com/${githubRepo}.git`,
    cloneDir,
  ]);
  await Promise.all(
    allStrategies.map((strategy) =>
      runBenchmark(githubRepo, cloneDir, strategy),
    ),
  );
  await fs.emptyDir(cloneDir);
  await Deno.remove(cloneDir);
};

const [cmd, arg] = getArgs();
switch (cmd) {
  case "benchmark": {
    console.error("Running benchmarks");
    await runAllBenchmarks(arg);
    break;
  }
  case "compileData": {
    console.error("Compiling data");
    const data = collectCommitBenchmarks();
    const output: string = data.map((line) => line.join(",")).join("\n");
    console.log(output);
    break;
  }
}
