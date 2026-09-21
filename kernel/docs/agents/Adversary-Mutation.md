# Adversary — Mutation check (appendix to §3.3.1)

> **Read this if and only if** you suspect a fake test: green, but possibly not asserting the AC at all ([`Adversary.md` §3.3](./Adversary.md)). No suspicion, skip it — this procedure is optional, split out so `adversary` does not pay to read it on every task.

§2 forbids this role from editing code, and [`../Instructions.md` §1](../Instructions.md) forbids `git stash` / `restore` / `checkout --`. So the "change a constant and see if the test goes red" probe is **not** run on the implementer's tree — run it in a detached worktree and delete it afterwards:

```bash
BASE=$(git rev-parse HEAD)
git worktree add --detach /tmp/adv-$$ "$BASE"     # a separate copy; the implementer's tree is untouched
# change the constant inside /tmp/adv-$$, run exactly the test command for that AC
git worktree remove --force /tmp/adv-$$           # remove ONLY the worktree you just created
```

Three conditions make this safe: the worktree was created by this role, it is `--detach` (claims no branch), and `remove` targets exactly the path just created. Touch no other worktree.

> `worktree add` does not carry uncommitted code across. What you need to establish is whether **the test catches a behaviour change** — running on `HEAD` plus hand-copying the one file under examination is enough. If you cannot copy it (build state, env), record that under "Limits of this review" and do **not** claim you tried.
