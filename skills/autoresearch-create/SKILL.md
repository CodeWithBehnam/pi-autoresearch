---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Gathers what to optimize, then starts the loop immediately. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch — Setup & Run

Set up an autonomous experiment loop and start running immediately.

## Tools

You have two custom tools from the autoresearch extension. **Always use these instead of raw bash for experiments:**

- **`init_experiment`** — call once at the start to configure the session. Sets the experiment name, primary metric name, unit, and direction. Writes config to `autoresearch.jsonl`. Do NOT call if `autoresearch.jsonl` already exists.
- **`run_experiment`** — pass it a `command` to run. It times execution, captures output, detects pass/fail via exit code.
- **`log_experiment`** — records each experiment's `commit`, `metric`, `status` (keep/discard/crash), and `description`. Auto-commits on `keep` with a `Result: {...}` trailer. Persists to `autoresearch.jsonl`. Dashboard toggle: ctrl+x.
  - `metrics` — optional dict of secondary metric name→value for tradeoff monitoring, e.g. `{"parse_µs": 5505, "render_µs": 1440}`

  The first experiment is always the baseline. The inline widget shows the best metric vs baseline as a delta %, e.g. `★ total_µs: 6,945 (-21.2%)`.

## Step 1: Gather Context

Ask the user (propose smart defaults based on the codebase):

1. **Goal** — what are we optimizing? (e.g. "reduce vitest execution time")
2. **Command** — shell command to run per experiment (e.g. `pnpm test:vitest`)
3. **Metric** — what number to measure, and is lower or higher better?
4. **Files in scope** — what can you modify?
5. **Constraints** — hard rules (e.g. "all tests must pass", "don't delete files")

If the user already provided these in their prompt, skip asking and confirm your understanding.

## Step 2: Setup

1. **Create a branch**: `git checkout -b autoresearch/<tag>` (propose a tag based on the goal + date).
2. **Read the relevant files** to understand what you're working with.
3. **Write `autoresearch.md`** and **`autoresearch.sh`** in the working directory. These are committed to the autoresearch branch and allow any agent to resume the work later.

### `autoresearch.md` — The experiment rules

This is the **static configuration** for the research session. It defines the rules, scope, and constraints. Write it so that a fresh agent session can read it and know exactly what to do. **Do not update this file during the loop** — only update it when the user asks to change the experiment setup.

```markdown
# Autoresearch: <goal>

## Objective
<What we're optimizing and why. Be specific about the workload.>

## How to Run
Run `./autoresearch.sh` — it sets up the environment and runs the benchmark,
outputting metrics in the format the agent expects.

## Metrics
- **Primary (optimization target)**: <name> (<unit>, lower/higher is better)
- **Secondary (tradeoff monitoring)**: <name> (<unit>), <name> (<unit>), ...
<Explain what each metric measures and why it matters.>

## Files in Scope
<List every file/directory the agent is allowed to modify.>
- `path/to/file1` — <what it does>
- `path/to/file2` — <what it does>

## Off Limits
<Files/patterns that must NOT be modified.>
- `test/` — tests must continue to pass unchanged
- ...

## Constraints
<Hard rules the agent must respect.>
- All tests must pass
- No new dependencies
- ...
```

### `autoresearch.sh` — The benchmark runner

This is the single command you run via `run_experiment`. It must be **self-contained, reliable, and produce structured output**. The agent parses the `METRIC` lines to feed into `log_experiment`.

**You can and should update `autoresearch.sh` during the experiment loop** if you find ways to make it more robust, faster, or more informative. For example:
- Add pre-checks that catch common failures early (syntax check, dependency check)
- Improve error messages so failures are self-explanatory
- Add more METRIC lines if a new measurement proves valuable (use `force: true` in `log_experiment`)
- Optimize the script itself (fewer iterations if results are stable, skip unnecessary setup)

**Requirements:**

1. Start with `#!/bin/bash` and `set -euo pipefail`
2. **Pre-checks** — verify the environment is ready before running the benchmark:
   - Check that required files/binaries exist
   - Run a quick syntax/compile check if applicable (catches trivial errors fast)
   - If a pre-check fails, print a clear error and exit non-zero immediately
3. **Setup** — build, compile, install, whatever is needed. Keep it minimal — skip steps that aren't needed every run.
4. **Run the benchmark** — execute the actual workload.
5. **Output metrics** — print each metric on its own line in this exact format:
   ```
   METRIC total_us=6945
   METRIC parse_us=5505
   METRIC render_us=1440
   METRIC allocations=39847
   ```
   The format is `METRIC <name>=<number>`. No spaces around `=`. One per line.
6. **Exit code** — exit 0 on success, non-zero on failure.

**Example skeleton:**

```bash
#!/bin/bash
set -euo pipefail

# Pre-checks
if ! command -v ruby &>/dev/null; then
  echo "ERROR: ruby not found" >&2
  exit 1
fi

# Quick syntax check (catches trivial errors in <1s)
ruby -c lib/my_file.rb 2>&1 || { echo "ERROR: syntax error" >&2; exit 1; }

# Setup (only if needed)
bundle exec rake compile 2>&1

# Run benchmark
output=$(ruby benchmark/run.rb 2>&1)
echo "$output"

# Extract and emit metrics
total=$(echo "$output" | grep -oP 'total: \K[0-9]+')
parse=$(echo "$output" | grep -oP 'parse: \K[0-9]+')
echo "METRIC total_us=$total"
echo "METRIC parse_us=$parse"
```

**Tips:**
- **Fast feedback**: if the script can detect failure in <1 second (syntax error, missing file), do that before the expensive benchmark run.
- **Determinism**: if the benchmark has variance, run multiple iterations and report the median or minimum.
- **Keep it fast**: every second saved on the script is multiplied by hundreds of experiment runs.
- The agent uses `run_experiment` with `command: "./autoresearch.sh"` — make sure it's `chmod +x`.

4. **Commit both files**: `git add autoresearch.md autoresearch.sh && git commit -m "autoresearch: setup experiment plan and runner"`
5. **Initialize**: call `init_experiment` with the session name, primary metric name, unit, and direction.
6. **Run the baseline**: use `run_experiment` with `./autoresearch.sh`, parse the METRIC output, then `log_experiment` to record it. The first experiment automatically becomes the baseline. Include secondary `metrics` from the METRIC lines.
7. **Start looping** — do NOT wait for confirmation after the baseline. Go.

## Step 3: Experiment Loop

You are a completely autonomous researcher. You try ideas, keep what works, discard what doesn't, and iterate.

LOOP FOREVER:

1. **Think of an experiment idea.** Read the codebase for inspiration. Consider:
   - Config changes (parallelism, caching, pooling, environment)
   - Removing unnecessary work (unused setup, redundant transforms)
   - Structural changes (splitting, merging, reordering)
   - Combining previous near-misses that each almost worked
   - More radical changes if incremental ones have plateaued
2. Edit files with the idea.
3. Use `run_experiment` with `./autoresearch.sh`.
4. Parse the `METRIC` lines from the output. **Always call `log_experiment`** — for keeps, discards, and crashes.
   - On `keep`: `log_experiment` auto-commits with the description and a `Result: {...}` trailer.
   - On `discard`/`crash`: `log_experiment` records it but skips the commit. Then `git checkout -- .` to revert your changes.
5. **Keep/discard is based on the primary metric.** If it improved AND constraints are met → `keep`. If a secondary metric got worse but primary improved, still **keep it**.
6. If the primary metric is worse or equal → `log_experiment` with `discard` or `crash`, then `git checkout -- .` to revert. In extreme cases you may discard a tiny primary improvement that catastrophically degrades a secondary metric — document why in the description.
7. Repeat.

### Simplicity criterion

All else being equal, simpler is better. Weigh complexity cost against improvement magnitude:
- A small improvement that adds ugly complexity? Probably not worth it.
- Removing code and getting equal or better results? Definitely keep — that's a simplification win.
- A near-zero improvement but much simpler code? Keep.

### Never stop

**NEVER STOP.** Loop indefinitely until the user interrupts. Do not ask "should I continue?" or "is this a good stopping point?". The user may be away and expects you to work autonomously. If you run out of obvious ideas, think harder — re-read the in-scope files for new angles, try combining previous near-misses, try more radical changes. The loop runs until interrupted, period.

### Optimize ruthlessly

**⚠️ The primary metric is king.** Secondary metrics are for monitoring tradeoffs — they almost never affect keep/discard. Only override in extreme situations (tiny primary gain + catastrophic secondary regression), and document why.

### Don't thrash

If you find yourself repeatedly reverting, step back and think about a different approach. Don't keep trying small variations of the same failed idea. Move on to something structurally different.

### Crash handling

Use your judgment:
- **Dumb fix** (typo, missing import, syntax error): fix it and re-run.
- **Fundamentally broken** (the idea itself doesn't work): log as `crash`, revert, move on. Don't spend more than a couple of attempts on a broken idea.

### Resuming

If `autoresearch.md` and `autoresearch.sh` already exist, read them and continue the loop — no need to re-gather context or re-run the baseline. Check the git log for what's been tried recently.

## Example Domains

- **Test speed**: metric=seconds ↓, command=`pnpm test`, scope=vitest/jest configs
- **Bundle size**: metric=KB ↓, command=`pnpm build && du -sb dist`, scope=bundler config
- **Build speed**: metric=seconds ↓, command=`pnpm build`, scope=tsconfig + bundler
- **LLM training**: metric=val_bpb ↓, command=`uv run train.py`, scope=train.py
- **Lighthouse score**: metric=perf score ↑, command=`lighthouse --output=json`, scope=components
