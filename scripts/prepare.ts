// `bun install`'s prepare step: install the git hooks (lefthook), from the main checkout only. The
// hooks live in the repository's shared .git, and lefthook writes the installing checkout's own
// node_modules path into them: run from a linked worktree, every checkout's hooks would point into
// that worktree and break when it's removed.
const git = (...args: ReadonlyArray<string>) =>
  Bun.spawnSync(["git", ...args])
    .stdout.toString()
    .trim()

const linked = git("rev-parse", "--git-dir") !== git("rev-parse", "--git-common-dir")

if (!linked)
  process.exit(
    Bun.spawnSync(["bun", "x", "lefthook", "install"], { stdio: ["inherit", "inherit", "inherit"] })
      .exitCode,
  )
