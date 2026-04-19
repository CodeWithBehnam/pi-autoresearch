/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - Ctrl+X toggle to expand/collapse full dashboard inline above the editor
 * - Adds autoresearch guidance to the system prompt and points the agent at autoresearch.md
 * - Injects autoresearch.md into context on every turn via before_agent_start
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, truncateToWidth, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
interface ASI {
  [key: string]: unknown;
}

const AUTORESEARCH_SCHEMA_VERSION = 2;
const AUTORESEARCH_STATE_FILE = "autoresearch.jsonl";

interface RunArtifactBundle {
  runId: string;
  command: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  preHead: string;
  preBranch: string;
  preStatus: string;
  postStatus: string;
  changedFiles: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  untrackedFiles: string[];
  diffStats: {
    files: number;
    insertions: number;
    deletions: number;
  };
  artifactPath: string;
  environment: {
    os: string;
    node: string;
    platform: string;
    cwd: string;
    ci: boolean;
  };
}

interface ResultConstraintViolation {
  metric: string;
  reason: "min" | "max";
  expected: number | null;
  actual: number;
}

interface ResultConstraint {
  min?: number;
  max?: number;
}

interface ResultObjectives {
  /** Optional metric weights for multi-objective scoring; primary metric should be 1+ by default. */
  metricWeights: Record<string, number>;
  /** Optional hard constraints, e.g. compile_time_max. */
  constraints: Record<string, ResultConstraint>;
}

interface ExperimentRunContract {
  /** Require parsed primary metric from run_experiment output. */
  requirePrimaryMetric: boolean;
  /** Optional required secondary metrics to be present in METRIC output. */
  requiredSecondaryMetrics: string[];
}

interface AutoresearchPolicy {
  /** Regex-like patterns that are forbidden in run commands. */
  blockedCommandPatterns: string[];
  /** If present, command must start with one of these prefixes (unless empty => allow any). */
  allowedCommandPrefixes: string[];
  /** Hard limit on files changed in a successful run. */
  maxModifiedFilesPerRun: number | null;
  /** If true, soft violations are shown but still logged; if false, hard-block keep/accept. */
  allowSoftViolations: boolean;
  /** "warn" keeps running and records warning; "reject" hard-blocks the violating command. */
  onViolation: "warn" | "reject";
}

interface AutoresearchBudget {
  maxWallTimeSeconds: number | null;
  maxTokenBudget: number | null;
  stagnationWindow: number | null;
  minStagnationRatio: number | null;
}

interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Context tokens consumed during this iteration (from run_experiment to log_experiment). null if unavailable. */
  iterationTokens: number | null;
  /** Optional strict run id for transaction safety. */
  runId?: string;
  /** Optional reproducibility artifacts path for this run. */
  artifactPath?: string;
  /** Optional pre-computed scalarized score for multi-objective support. */
  objectiveScore?: number | null;
  /** Optional objective violations for constraints. */
  objectiveViolations?: ResultConstraintViolation[];
  /** Optional structured side metadata for forensics/reproducibility. */
  schemaVersion: number;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
}

interface MetricDef {
  name: string;
  unit: string;
}

interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
  /** Optional objective settings attached to this segment/session. */
  objectiveWeights: Record<string, number>;
  /** Optional objective constraints used by query and scoring logic. */
  objectiveConstraints: Record<string, ResultConstraint>;
}

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;
  /** Any contract enforcement issues found while parsing. */
  metricContractViolations?: string[];
  /** Command-policy warnings surfaced in run_experiment. */
  policyWarnings?: string[];
  /** Internal run id for strict run/log pairing */
  runId?: string;
  /** Artifact location for reproducibility bundle and diff summary. */
  artifactPath?: string;
  /** Snapshot id used for idempotency and forensics. */
  runArtifact?: RunArtifactBundle;
}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
  runArtifact?: RunArtifactBundle;
  budgetCheck?: {
    paused: boolean;
    reason: string;
  };
}
enum AutoresearchModeState {
  Idle = "idle",
  Active = "active",
  Rehydrating = "rehydrating",
  SegmentReady = "segment_ready",
  Running = "running",
  AwaitingLog = "awaiting_log",
  Terminal = "terminal",
}

enum AutoresearchMachineEvent {
  RehydrateStart = "rehydrate_start",
  RehydrateDone = "rehydrate_done",
  ModeOn = "mode_on",
  ModeOff = "mode_off",
  Clear = "clear",
  InitExperiment = "init_experiment",
  RunRequested = "run_requested",
  RunBlocked = "run_blocked",
  RunCompleted = "run_completed",
  LogApplied = "log_applied",
  MaxReached = "max_reached",
}

interface AutoresearchMachineTrace {
  event: AutoresearchMachineEvent;
  to: AutoresearchModeState;
  at: number;
  reason?: string;
}

interface AutoresearchRuntime {
  autoresearchMode: boolean;
  dashboardExpanded: boolean;
  lastAutoResumeTime: number;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  runningExperiment: { startedAt: number; command: string } | null;
  state: ExperimentState;
  /** Context tokens at the start of the current run_experiment call. null if not running. */
  iterationStartTokens: number | null;
  /** Token cost of each completed iteration (for predicting context exhaustion). */
  iterationTokenHistory: number[];

  /** Explicit machine state for autoresearch workflow and transition tracking. */
  modeState: AutoresearchModeState;
  /** Last machine transition for debug and reconciliation. */
  lastMachineTrace: AutoresearchMachineTrace | null;
  /** Id for the pending run awaiting log_experiment; tracks run/log ownership. */
  pendingRunId: string | null;
  /** Last captured run details, for optional ownership checks. */
  lastRunSummary: RunDetails | null;
  /** Run ids already logged in this session (for idempotent log handling). */
  loggedRunIds: Set<string>;
  /** Session mode timestamp for budgets/time-based stopping. */
  segmentStartedAt: number | null;
  /** Session-level budget snapshot config derived from autoresearch.config.json. */
  budgets: AutoresearchBudget;
  /** Active safety policy for commands and file changes. */
  policy: AutoresearchPolicy;
  /** Active metric contract to validate outputs. */
  metricContract: ExperimentRunContract;
  /** If true, user requested pause due to budget/stagnation. */
  pausedByBudget: boolean;
  /** Last baseline snapshot for run reproducibility.
   * not persisted, for idempotent / forensic analysis. */
  lastRunArtifactPreState: { command: string; startedAt: number; head: string } | null;

}

function createMachineTrace(
  event: AutoresearchMachineEvent,
  to: AutoresearchModeState,
  reason?: string
): AutoresearchMachineTrace {
  return {
    event,
    to,
    at: Date.now(),
    reason,
  };
}

function transitionMachineState(
  runtime: AutoresearchRuntime,
  event: AutoresearchMachineEvent,
  reason?: string
): AutoresearchModeState {
  const current = runtime.modeState;
  let next = current;

  switch (event) {
    case AutoresearchMachineEvent.ModeOn:
      next = AutoresearchModeState.Active;
      break;
    case AutoresearchMachineEvent.ModeOff:
    case AutoresearchMachineEvent.Clear:
      next = AutoresearchModeState.Idle;
      break;
    case AutoresearchMachineEvent.RehydrateStart:
      next = AutoresearchModeState.Rehydrating;
      break;
    case AutoresearchMachineEvent.RehydrateDone:
      next = runtime.autoresearchMode ? AutoresearchModeState.SegmentReady : AutoresearchModeState.Idle;
      break;
    case AutoresearchMachineEvent.InitExperiment:
      next = AutoresearchModeState.SegmentReady;
      break;
    case AutoresearchMachineEvent.RunRequested:
      next = current === AutoresearchModeState.Terminal ? current : AutoresearchModeState.Running;
      break;
    case AutoresearchMachineEvent.RunBlocked:
      next = current;
      break;
    case AutoresearchMachineEvent.RunCompleted:
      next = AutoresearchModeState.AwaitingLog;
      break;
    case AutoresearchMachineEvent.LogApplied:
      if (runtime.state.maxExperiments !== null) {
        const segCount = currentResults(runtime.state.results, runtime.state.currentSegment).length;
        next = segCount >= runtime.state.maxExperiments
          ? AutoresearchModeState.Terminal
          : AutoresearchModeState.SegmentReady;
      } else {
        next = AutoresearchModeState.SegmentReady;
      }
      break;
    case AutoresearchMachineEvent.MaxReached:
      next = AutoresearchModeState.Terminal;
      break;
    default:
      next = current;
  }

  runtime.modeState = next;
  runtime.lastMachineTrace = createMachineTrace(event, next, reason);
  return next;
}

function newPendingRunId(): string {
  return randomBytes(6).toString("hex");
}

function clearPendingRun(runtime: AutoresearchRuntime): void {
  runtime.pendingRunId = null;
  runtime.lastRunSummary = null;
  runtime.lastRunArtifactPreState = null;
}

function safeExecGit(workDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    }).trim();
  } catch {
    return "";
  }
}

function gitStatusSnapshot(workDir: string): {
  branch: string;
  head: string;
  status: string;
  changedFiles: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  untrackedFiles: string[];
  numstat: { files: number; insertions: number; deletions: number };
} {
  const branch = safeExecGit(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const head = safeExecGit(workDir, ["rev-parse", "HEAD"]) || "(unknown)";
  const status = safeExecGit(workDir, ["status", "--short"]) || "";

  const changedFiles: string[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];

  for (const raw of status.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (raw.length < 3) continue;
    const file = raw.slice(3).trim();
    if (!file) continue;
    const code = raw.slice(0, 2);
    changedFiles.push(file);

    if (code === "??") {
      untracked.push(file);
      continue;
    }

    if (code.includes("D") || code[1] === "D") {
      deleted.push(file);
      continue;
    }

    if (code.includes("A") || code[0] === "A") {
      added.push(file);
      continue;
    }

    if (code.includes("M") || code[0] === "M" || code[1] === "M") {
      modified.push(file);
      continue;
    }
  }

  const numstatRaw = safeExecGit(workDir, ["diff", "--numstat"]);
  let insertions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of numstatRaw.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [ins, del] = line.split("\t");
    if (!ins || !del) continue;
    const insN = Number(ins);
    const delN = Number(del);
    if (Number.isFinite(insN) && Number.isFinite(delN)) {
      files++;
      insertions += insN;
      deletions += delN;
    }
  }

  return {
    branch,
    head,
    status,
    changedFiles: Array.from(new Set(changedFiles)),
    addedFiles: Array.from(new Set(added)),
    modifiedFiles: Array.from(new Set(modified)),
    deletedFiles: Array.from(new Set(deleted)),
    untrackedFiles: Array.from(new Set(untracked)),
    numstat: { files, insertions, deletions },
  };
}

function createRunArtifactBundle(
  runId: string,
  command: string,
  workDir: string,
  startedAt: number,
  finishedAt: number,
  preSnapshot: ReturnType<typeof gitStatusSnapshot>,
  postSnapshot: ReturnType<typeof gitStatusSnapshot>
): RunArtifactBundle {
  const preSet = new Set(preSnapshot.changedFiles);
  const addedByRun = postSnapshot.addedFiles.filter((file) => !preSet.has(file));
  const modifiedByRun = postSnapshot.modifiedFiles.filter((file) => !preSet.has(file));
  const deletedByRun = postSnapshot.deletedFiles.filter((file) => !preSet.has(file));
  const untrackedByRun = postSnapshot.untrackedFiles.filter((file) => !preSet.has(file));

  const runChangedFiles = Array.from(new Set([
    ...addedByRun,
    ...modifiedByRun,
    ...deletedByRun,
    ...untrackedByRun,
  ]));

  return {
    runId,
    command,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    preHead: preSnapshot.head,
    preBranch: preSnapshot.branch,
    preStatus: preSnapshot.status,
    postStatus: postSnapshot.status,
    changedFiles: runChangedFiles,
    addedFiles: addedByRun,
    modifiedFiles: modifiedByRun,
    deletedFiles: deletedByRun,
    untrackedFiles: untrackedByRun,
    diffStats: {
      files: Math.max(preSnapshot.numstat.files, postSnapshot.numstat.files),
      insertions: Math.max(preSnapshot.numstat.insertions, postSnapshot.numstat.insertions),
      deletions: Math.max(preSnapshot.numstat.deletions, postSnapshot.numstat.deletions),
    },
    artifactPath: "",
    environment: {
      os: process.platform,
      node: process.version,
      platform: process.platform,
      cwd: workDir,
      ci: process.env.CI === "1" || process.env.CI?.toLowerCase() === "true",
    },
  };
}

function writeRunArtifact(bundle: RunArtifactBundle, runId: string): string {
  const artifactsDir = path.join(tmpdir(), "pi-autoresearch-artifacts");
  const artifactPath = path.join(artifactsDir, `${runId}.json`);
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(bundle, null, 2), "utf-8");
  } catch {
    return "";
  }
  return artifactPath;
}

function evaluateCommandPolicy(
  command: string,
  policy: AutoresearchPolicy
): { blocked: boolean; warning?: string } {
  const trimmed = command.trim();

  if (policy.allowedCommandPrefixes.length > 0) {
    const hasAllowed = policy.allowedCommandPrefixes.some((prefix) => typeof prefix === "string" && trimmed.startsWith(prefix));
    if (!hasAllowed) {
      const reason = `command does not match allowed prefixes (${policy.allowedCommandPrefixes.join(", ")})`;
      return {
        blocked: policy.onViolation === "reject",
        warning: reason,
      };
    }
  }

  for (const pattern of policy.blockedCommandPatterns) {
    if (typeof pattern !== "string") continue;
    try {
      const re = new RegExp(pattern);
      if (re.test(trimmed)) {
        return {
          blocked: policy.onViolation === "reject",
          warning: `command matches blocked pattern: ${pattern}`,
        };
      }
    } catch {
      // ignore malformed regex in config
    }
  }

  return {
    blocked: false,
  };
}

function evaluateMetricContract(
  metricName: string,
  parsedPrimary: number | null,
  parsedMetrics: Record<string, number> | null,
  contract: ExperimentRunContract
): string[] {
  const violations: string[] = [];

  if (contract.requirePrimaryMetric && parsedPrimary === null) {
    violations.push(`Missing required primary metric \"${metricName}\"`);
  }

  for (const metric of contract.requiredSecondaryMetrics) {
    if (!parsedMetrics || !(metric in parsedMetrics)) {
      violations.push(`Missing required metric \"${metric}\"`);
    }
  }

  return violations;
}

function evaluateBudgetLimits(runtime: AutoresearchRuntime): { blocked: boolean; reason?: string } {
  const { maxWallTimeSeconds, maxTokenBudget, stagnationWindow, minStagnationRatio } = runtime.budgets;

  if (maxWallTimeSeconds !== null) {
    const segmentStart = runtime.segmentStartedAt;
    if (segmentStart !== null) {
      const elapsedSeconds = Math.floor((Date.now() - segmentStart) / 1000);
      if (elapsedSeconds > maxWallTimeSeconds) {
        return {
          blocked: true,
          reason: `segment wall-clock budget reached: ${elapsedSeconds}s > ${maxWallTimeSeconds}s`,
        };
      }
    }
  }

  if (maxTokenBudget !== null) {
    const projected = runtime.iterationTokenHistory.reduce((sum, value) => sum + value, 0);
    if (projected >= maxTokenBudget) {
      return {
        blocked: true,
        reason: `token budget reached: ${projected} ≥ ${maxTokenBudget}`,
      };
    }
  }

  if (stagnationWindow !== null && minStagnationRatio !== null && runtime.state.results.length > 0) {
    const segment = currentResults(runtime.state.results, runtime.state.currentSegment);
    const window = segment.slice(Math.max(0, segment.length - stagnationWindow));

    if (window.length >= Math.max(3, stagnationWindow)) {
      const keeps = window.filter((run) => run.status === "keep" && run.metric > 0);
      if (keeps.length >= 1) {
        const baseline = findBaselineMetric(runtime.state.results, runtime.state.currentSegment);
        if (baseline !== null && baseline !== 0) {
          const bestInWindow = keeps.reduce(
            (best, run) => isBetter(run.metric, best, runtime.state.bestDirection) ? run.metric : best,
            keeps[0].metric
          );
          const improvement = runtime.state.bestDirection === "lower"
            ? (baseline - bestInWindow) / baseline
            : (bestInWindow - baseline) / baseline;

          if (improvement >= 0 && improvement < minStagnationRatio) {
            return {
              blocked: true,
              reason: `stagnation window (${stagnationWindow}) no meaningful progress: ${(improvement * 100).toFixed(2)}% < ${(minStagnationRatio * 100).toFixed(2)}%`,
            };
          }
        }
      }
    }
  }

  return { blocked: false };
}

function evaluateObjectives(
  state: ExperimentState,
  metric: number,
  metrics: Record<string, number>,
): {
  score: number | null;
  violations: ResultConstraintViolation[];
} {
  const weights = state.objectiveWeights ?? {};
  const constraints = state.objectiveConstraints ?? {};

  const activeWeights: Record<string, number> = {
    [state.metricName]: 1,
    ...weights,
  };

  const violations: ResultConstraintViolation[] = [];

  const entries = Object.entries(constraints);
  if (entries.length > 0) {
    const resolveMetric = (name: string): number | undefined => {
      if (name === state.metricName) return metric;
      return metrics[name];
    };

    for (const [metricName, constraint] of entries) {
      const value = resolveMetric(metricName);
      if (value === undefined || !Number.isFinite(value)) continue;
      if (constraint.min !== undefined && value < constraint.min) {
        violations.push({ metric: metricName, reason: "min", expected: constraint.min, actual: value });
      }
      if (constraint.max !== undefined && value > constraint.max) {
        violations.push({ metric: metricName, reason: "max", expected: constraint.max, actual: value });
      }
    }
  }

  let score = null as number | null;
  const allMetrics: Record<string, number> = {
    ...metrics,
    [state.metricName]: metric,
  };

  for (const [name, rawWeight] of Object.entries(activeWeights)) {
    const raw = allMetrics[name];
    if (!Number.isFinite(raw)) continue;

    const weight = Number(rawWeight);
    if (!Number.isFinite(weight)) continue;

    const signed = name === state.metricName && state.bestDirection === "lower"
      ? -raw
      : raw;

    score = (score ?? 0) + signed * weight;
  }

  return { score, violations };
}

function shortCommit(input: string): string {
  const trimmed = input.trim();
  return trimmed.length >= 7 ? trimmed.slice(0, 7) : trimmed;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill autoresearch.checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    })
  ),
});

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  metrics: Type.Optional(
    Type.Record(Type.String(), Type.Number(), {
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
  asi: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields.',
    })
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
const METRIC_LINE_PREFIX = "METRIC";

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Example:
 *   METRIC total_µs=15200
 *   METRIC compile_µs=4200
 *
 * Names must be word chars, dots, or µ (rejects `=` and other specials).
 * Values must be finite numbers (rejects Infinity, NaN, hex, etc.).
 * Duplicate names: last occurrence wins (allows scripts to refine values).
 * Returns a Map preserving insertion order of first occurrence per key.
 */
/** Metric names that could cause prototype pollution if used as object keys */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

/** Lazy temp file allocator — returns the same path on subsequent calls */
function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Kill a process tree (best effort, tries process group first) */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/**
 * Check if a command's primary purpose is running autoresearch.sh.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is autoresearch.sh invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; autoresearch.sh" because
 * we require autoresearch.sh to be the *first* real command.
 */
function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Now the core command must be autoresearch.sh via a known invocation:
  //   autoresearch.sh
  //   ./autoresearch.sh
  //   /path/to/autoresearch.sh
  //   bash [-flags] autoresearch.sh
  //   bash [-flags] ./autoresearch.sh
  //   bash [-flags] /path/to/autoresearch.sh
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh(?:\s|$)/.test(cmd);
}

function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

// Why 1.2: iterations vary in cost; 20% buffer prevents overflow on heavier iterations
const CONTEXT_SAFETY_MARGIN = 1.2;

function estimateTokensPerIteration(history: number[]): number {
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const sorted = [...history].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Why max(mean, median): outlier-heavy runs inflate the mean, skewed runs inflate the median.
  // Taking the larger gives a conservative estimate that handles both distributions.
  return Math.max(mean, median);
}

function hasRoomForNextIteration(history: number[], currentTokens: number, contextWindow: number): boolean {
  if (history.length < 1) return true;
  const projectedTokens = currentTokens + estimateTokensPerIteration(history) * CONTEXT_SAFETY_MARGIN;
  return projectedTokens <= contextWindow;
}

function recordIterationTokens(runtime: AutoresearchRuntime, currentTokens: number | null): void {
  if (runtime.iterationStartTokens == null || currentTokens == null) return;
  const tokensConsumed = currentTokens - runtime.iterationStartTokens;
  if (tokensConsumed <= 0) return;
  runtime.iterationTokenHistory.push(tokensConsumed);
}

function lastIterationTokens(runtime: AutoresearchRuntime): number | null {
  if (runtime.iterationTokenHistory.length === 0) return null;
  return runtime.iterationTokenHistory[runtime.iterationTokenHistory.length - 1];
}

function advanceIterationTracking(runtime: AutoresearchRuntime, ctx: ExtensionContext): void {
  const usage = ctx.getContextUsage();
  if (usage?.tokens == null) return;
  runtime.iterationStartTokens = usage.tokens;
}

function isContextExhausted(runtime: AutoresearchRuntime, ctx: ExtensionContext): boolean {
  const usage = ctx.getContextUsage();
  if (usage?.tokens == null) return false;
  return !hasRoomForNextIteration(runtime.iterationTokenHistory, usage.tokens, usage.contextWindow);
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there are fewer than 3 data points (insufficient data)
 * or when MAD is 0 (all values identical — no measurable noise).
 */
function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

/** Get results in the current segment only */
function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
  metricContract?: {
    requirePrimaryMetric?: boolean;
    requiredSecondaryMetrics?: string[];
  };
  objectives?: {
    metricWeights?: Record<string, number>;
    constraints?: Record<string, ResultConstraint>;
  };
  policy?: {
    blockedCommandPatterns?: string[];
    allowedCommandPrefixes?: string[];
    maxModifiedFilesPerRun?: number;
    allowSoftViolations?: boolean;
    onViolation?: "warn" | "reject";
  };
  budgets?: {
    maxWallTimeSeconds?: number;
    maxTokenBudget?: number;
    stagnationWindow?: number;
    minStagnationRatio?: number;
  };
}

const DEFAULT_DENIED_COMMAND_PATTERNS = [
  "\\brm\\s+-rf\\s+/",
  "\\brm\\s+-rf\\s+(?:$|[\"'])?/$",
  "\\bmkfs\\b",
  "\\bdd\\s+if=",
  "\\bformat\\b",
  "\\bsudo\\s+chmod\\s+-R\\s+777\\b",
];

const DEFAULT_ALLOWED_PREFIXES: string[] = [];

function defaultAutoresearchPolicy(): AutoresearchPolicy {
  return {
    blockedCommandPatterns: [...DEFAULT_DENIED_COMMAND_PATTERNS],
    allowedCommandPrefixes: [...DEFAULT_ALLOWED_PREFIXES],
    maxModifiedFilesPerRun: null,
    allowSoftViolations: true,
    onViolation: "reject",
  };
}

function defaultAutoresearchBudgets(): AutoresearchBudget {
  return {
    maxWallTimeSeconds: null,
    maxTokenBudget: null,
    stagnationWindow: null,
    minStagnationRatio: null,
  };
}

function defaultMetricContract(): ExperimentRunContract {
  return {
    requirePrimaryMetric: false,
    requiredSecondaryMetrics: [],
  };
}

function defaultResultObjectives(): ResultObjectives {
  return {
    metricWeights: {},
    constraints: {},
  };
}

/** Read autoresearch.config.json from the given directory (always ctx.cwd) */
function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = path.join(cwd, "autoresearch.config.json");
    if (!fs.existsSync(configPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed as AutoresearchConfig : {};
  } catch {
    return {};
  }
}

function readMetricContract(cwd: string): ExperimentRunContract {
  const config = readConfig(cwd);
  const contract = config.metricContract ?? {};
  return {
    requirePrimaryMetric: contract.requirePrimaryMetric === true,
    requiredSecondaryMetrics: Array.isArray(contract.requiredSecondaryMetrics)
      ? contract.requiredSecondaryMetrics
      : [],
  };
}

function readObjectives(cwd: string): ResultObjectives {
  const config = readConfig(cwd);
  const objectiveConfig = config.objectives ?? {};

  const metricWeights: Record<string, number> = {};
  if (typeof objectiveConfig.metricWeights === "object" && objectiveConfig.metricWeights) {
    for (const [name, value] of Object.entries(objectiveConfig.metricWeights)) {
      const asNum = Number(value);
      if (Number.isFinite(asNum)) {
        metricWeights[name] = asNum;
      }
    }
  }

  const constraints: Record<string, ResultConstraint> = {};
  if (typeof objectiveConfig.constraints === "object" && objectiveConfig.constraints) {
    for (const [name, raw] of Object.entries(objectiveConfig.constraints)) {
      if (!raw || typeof raw !== "object") continue;
      const constraint = raw as Record<string, unknown>;
      const next: ResultConstraint = {};

      const rawMin = Number(constraint.min);
      const rawMax = Number(constraint.max);
      if (Number.isFinite(rawMin)) {
        next.min = rawMin;
      }
      if (Number.isFinite(rawMax)) {
        next.max = rawMax;
      }

      if (next.min !== undefined || next.max !== undefined) {
        constraints[name] = next;
      }
    }
  }

  return {
    metricWeights,
    constraints,
  };
}

function readPolicy(cwd: string): AutoresearchPolicy {
  const config = readConfig(cwd);
  const policy = config.policy ?? {};
  const blockedPatterns = Array.isArray(policy.blockedCommandPatterns)
    ? policy.blockedCommandPatterns.filter((value): value is string => typeof value === "string")
    : defaultAutoresearchPolicy().blockedCommandPatterns;
  const allowedPrefixes = Array.isArray(policy.allowedCommandPrefixes)
    ? policy.allowedCommandPrefixes.filter((value): value is string => typeof value === "string")
    : defaultAutoresearchPolicy().allowedCommandPrefixes;

  return {
    blockedCommandPatterns: blockedPatterns,
    allowedCommandPrefixes: allowedPrefixes,
    maxModifiedFilesPerRun: typeof policy.maxModifiedFilesPerRun === "number" && policy.maxModifiedFilesPerRun > 0
      ? Math.floor(policy.maxModifiedFilesPerRun)
      : null,
    allowSoftViolations: policy.allowSoftViolations !== false,
    onViolation: policy.onViolation === "warn" ? "warn" : "reject",
  };
}

function readBudgets(cwd: string): AutoresearchBudget {
  const config = readConfig(cwd);
  const budget = config.budgets ?? {};
  const defaults = defaultAutoresearchBudgets();
  return {
    maxWallTimeSeconds: typeof budget.maxWallTimeSeconds === "number" && Number.isFinite(budget.maxWallTimeSeconds) && budget.maxWallTimeSeconds > 0
      ? Math.floor(budget.maxWallTimeSeconds)
      : defaults.maxWallTimeSeconds,
    maxTokenBudget: typeof budget.maxTokenBudget === "number" && Number.isFinite(budget.maxTokenBudget) && budget.maxTokenBudget > 0
      ? Math.floor(budget.maxTokenBudget)
      : defaults.maxTokenBudget,
    stagnationWindow: typeof budget.stagnationWindow === "number" && Number.isFinite(budget.stagnationWindow) && budget.stagnationWindow > 2
      ? Math.floor(budget.stagnationWindow)
      : defaults.stagnationWindow,
    minStagnationRatio: typeof budget.minStagnationRatio === "number" && Number.isFinite(budget.minStagnationRatio) && budget.minStagnationRatio > 0
      ? budget.minStagnationRatio
      : defaults.minStagnationRatio,
  };
}

function refreshRuntimeConfig(runtime: AutoresearchRuntime, cwd: string): void {
  const policy = readPolicy(cwd);
  const objectiveConfig = readObjectives(cwd);
  const budgets = readBudgets(cwd);
  const contract = readMetricContract(cwd);

  runtime.policy = policy;
  runtime.budgets = budgets;
  runtime.metricContract = contract;
  runtime.state.objectiveWeights = objectiveConfig.metricWeights;
  runtime.state.objectiveConstraints = objectiveConfig.constraints;
}

/** Read maxExperiments from autoresearch.config.json (if it exists) */
function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from autoresearch.config.json in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
function validateWorkDir(ctxCwd: string): string | null {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from autoresearch.config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from autoresearch.config.json) does not exist.`;
  }
  return null;
}

/** Baseline = first experiment in current segment */
function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
    objectiveWeights: { ...state.objectiveWeights },
    objectiveConstraints: { ...state.objectiveConstraints },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

function joinPartsToWidth(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    if (!part) continue;
    const next = line + part;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    return truncateToWidth(line || part, width, "…", true);
  }
  return truncateToWidth(line, width, "…", true);
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

function getTuiSize(tui: { terminal?: { columns?: number; rows?: number } }): { width: number; height: number } {
  return {
    width: tui.terminal?.columns ?? process.stdout.columns ?? 120,
    height: tui.terminal?.rows ?? process.stdout.rows ?? 40,
  };
}

function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
    objectiveWeights: {},
    objectiveConstraints: {},
  };
}

function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    dashboardExpanded: false,
    lastAutoResumeTime: 0,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    runningExperiment: null,
    state: createExperimentState(),
    iterationStartTokens: null,
    iterationTokenHistory: [],
    modeState: AutoresearchModeState.Idle,
    lastMachineTrace: null,
    pendingRunId: null,
    lastRunSummary: null,
    loggedRunIds: new Set(),
    segmentStartedAt: null,
    budgets: defaultAutoresearchBudgets(),
    policy: defaultAutoresearchPolicy(),
    metricContract: defaultMetricContract(),
    pausedByBudget: false,
    lastRunArtifactPreState: null,
  };
}

function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHint?: string
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix = st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHint
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, [
          headerHint,
          "ctrl+x collapse • full: c-s-x",
          "ctrl+x • c-s-x",
        ])
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const MAX_AUTORESUME_TURNS = 20;
  const BENCHMARK_GUARDRAIL =
    "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // Running experiment state (for spinner in fullscreen overlay)
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const clearOverlay = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay();
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
    }
  };

  const autoresearchHelp = () =>
    [
      "Usage: /autoresearch [off|clear|export|<text>]",
      "",
      "<text> enters autoresearch mode and starts or resumes the loop.",
      "off leaves autoresearch mode.",
      "clear deletes autoresearch.jsonl and turns autoresearch mode off.",
      "export opens a local live dashboard for autoresearch.jsonl in your browser.",

      "",
      "Examples:",
      "  /autoresearch optimize unit test runtime, monitor correctness",
      "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
      "  /autoresearch export",
    ].join("\n");

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    transitionMachineState(runtime, AutoresearchMachineEvent.RehydrateStart, "session_start/session_tree");
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    clearPendingRun(runtime);
    refreshRuntimeConfig(runtime, ctx.cwd);
    runtime.lastAutoResumeTime = 0;
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.iterationStartTokens = null;
    runtime.iterationTokenHistory = [];
    runtime.loggedRunIds = new Set();
    runtime.segmentStartedAt = null;
    runtime.lastRunArtifactPreState = null;
    runtime.pausedByBudget = false;
    runtime.state = createExperimentState();

    let state = runtime.state;

    // Resolve effective working directory (config stays in ctx.cwd, files in workDir)
    const workDir = resolveWorkDir(ctx.cwd);

    // Primary: read from autoresearch.jsonl (alongside autoresearch.md/sh)
    const jsonlPath = path.join(workDir, AUTORESEARCH_STATE_FILE);
    let loadedFromJsonl = false;
    try {
      if (fs.existsSync(jsonlPath)) {
        let segment = 0;
        const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Config header line — each header starts a new segment
            if (entry.type === "config") {
              if (entry.name) state.name = entry.name;
              if (entry.metricName) state.metricName = entry.metricName;
              if (entry.metricUnit !== undefined) state.metricUnit = entry.metricUnit;
              if (entry.bestDirection) state.bestDirection = entry.bestDirection;
              // Increment segment (first config = 0, second = 1, etc.)
              if (state.results.length > 0) {
                segment++;
                // Reset per-segment tracking (mirrors live reinit behavior)
                state.secondaryMetrics = [];
              }
              state.currentSegment = segment;
              continue;
            }

            // Experiment result line
            const iterationTokens = entry.iterationTokens ?? null;
            const schemaVersion =
              typeof entry.schemaVersion === "number" && Number.isFinite(entry.schemaVersion)
                ? entry.schemaVersion
                : 1;

            const parsedExperiment: ExperimentResult = {
              commit: entry.commit ?? "",
              metric: entry.metric ?? 0,
              metrics: entry.metrics ?? {},
              status: entry.status ?? "keep",
              description: entry.description ?? "",
              timestamp: entry.timestamp ?? 0,
              segment,
              confidence: entry.confidence ?? null,
              iterationTokens,
              asi: entry.asi ?? undefined,
              schemaVersion,
            };

            if (typeof entry.runId === "string") {
              parsedExperiment.runId = entry.runId;
              if (!runtime.loggedRunIds.has(entry.runId)) {
                runtime.loggedRunIds.add(entry.runId);
              }
            }

            if (typeof entry.artifactPath === "string") {
              parsedExperiment.artifactPath = entry.artifactPath;
            }

            if (typeof entry.objectiveScore === "number") {
              parsedExperiment.objectiveScore = entry.objectiveScore;
            }

            if (Array.isArray(entry.objectiveViolations)) {
              parsedExperiment.objectiveViolations = entry.objectiveViolations;
            }

            state.results.push(parsedExperiment);

            if (typeof iterationTokens === "number" && iterationTokens > 0) {
              runtime.iterationTokenHistory.push(iterationTokens);
            }

            // Register secondary metrics
            for (const name of Object.keys(parsedExperiment.metrics ?? {})) {
              if (!state.secondaryMetrics.find((m) => m.name === name)) {
                let unit = "";
                if (name.endsWith("µs")) unit = "µs";
                else if (name.endsWith("_ms")) unit = "ms";
                else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
                else if (name.endsWith("_kb")) unit = "kb";
                else if (name.endsWith("_mb")) unit = "mb";
                state.secondaryMetrics.push({ name, unit });
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
        if (state.results.length > 0) {
          loadedFromJsonl = true;
          state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
          state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);

          const segmentRuns = currentResults(state.results, state.currentSegment);
          const firstSegmentRun = segmentRuns[0];
          runtime.segmentStartedAt = firstSegmentRun ? firstSegmentRun.timestamp : Date.now();
          runtime.state.objectiveWeights = runtime.state.objectiveWeights || {};
          runtime.state.objectiveConstraints = runtime.state.objectiveConstraints || {};

          // Load objective settings from config as defaults; existing logs do not include them.
          const objectiveConfig = readObjectives(ctx.cwd);
          if (Object.keys(runtime.state.objectiveWeights).length === 0) {
            runtime.state.objectiveWeights = objectiveConfig.metricWeights;
          }
          if (Object.keys(runtime.state.objectiveConstraints).length === 0) {
            runtime.state.objectiveConstraints = objectiveConfig.constraints;
          }
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
            if (!r.schemaVersion) r.schemaVersion = 1;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
          }
          const objectiveConfig = readObjectives(ctx.cwd);
          if (Object.keys(state.objectiveWeights).length === 0) {
            state.objectiveWeights = objectiveConfig.metricWeights;
          }
          if (Object.keys(state.objectiveConstraints).length === 0) {
            state.objectiveConstraints = objectiveConfig.constraints;
          }
          runtime.state = cloneExperimentState(state);
          const segmentRuns = currentResults(state.results, state.currentSegment);
          const firstSegmentRun = segmentRuns[0];
          runtime.segmentStartedAt = firstSegmentRun ? firstSegmentRun.timestamp : Date.now();
          runtime.loggedRunIds = new Set(state.results
            .map((r) => r.runId)
            .filter((id): id is string => Boolean(id)));
        }
      }
    }


    // Read max experiments from config file
    state.maxExperiments = readMaxExperiments(ctx.cwd);

    // Auto-enter autoresearch mode only when a persisted experiment log exists
    runtime.autoresearchMode = fs.existsSync(path.join(workDir, AUTORESEARCH_STATE_FILE));

    // Drive machine state from reconstructed persistence
    transitionMachineState(
      runtime,
      runtime.autoresearchMode
        ? AutoresearchMachineEvent.RehydrateDone
        : AutoresearchMachineEvent.ModeOff,
      "reconstruction complete"
    );

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;

    if (state.results.length === 0) {
      if (!runtime.runningExperiment) {
        ctx.ui.setWidget("autoresearch", undefined);
        return;
      }

      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const runningLine = joinPartsToWidth(
            [
              theme.fg("accent", "🔬"),
              theme.fg("warning", " running…"),
              state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
              theme.fg("dim", ` │ ${runtime.runningExperiment?.command ?? ""}`),
              theme.fg("dim", " │ waiting for first logged result"),
            ],
            safeWidth
          );
          return [runningLine];
        },
        invalidate(): void {},
      }));
      return;
    }

    if (runtime.dashboardExpanded) {
      // Expanded: full dashboard table rendered as widget
      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
          const rows = safeWidth < 95 ? 4 : 6;

          return [
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            ),
            ...renderDashboardLines(
              state,
              safeWidth,
              theme,
              rows,
              "ctrl+x collapse • ctrl+shift+x fullscreen"
            ),
          ];
        },
        invalidate(): void {},
      }));
    } else {
      // Collapsed: compact one-liner — compute everything inside render
      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const cur = currentResults(state.results, state.currentSegment);
          const kept = cur.filter((r) => r.status === "keep").length;
          const crashed = cur.filter((r) => r.status === "crash").length;
          const checksFailed = cur.filter((r) => r.status === "checks_failed").length;
          const baseline = state.bestMetric;
          const baselineSec = findBaselineSecondary(
            state.results,
            state.currentSegment,
            state.secondaryMetrics
          );

          let bestPrimary: number | null = null;
          let bestSec: Record<string, number> = {};
          let bestRunNum = 0;
          for (let i = state.results.length - 1; i >= 0; i--) {
            const r = state.results[i];
            if (r.segment !== state.currentSegment) continue;
            if (r.status === "keep" && r.metric > 0) {
              if (bestPrimary === null || isBetter(r.metric, bestPrimary, state.bestDirection)) {
                bestPrimary = r.metric;
                bestSec = r.metrics ?? {};
                bestRunNum = i + 1;
              }
            }
          }

          const displayVal = bestPrimary ?? baseline;
          const essential = [
            theme.fg("accent", "🔬"),
            theme.fg("muted", ` ${state.results.length} runs`),
            theme.fg("success", ` ${kept} kept`),
            theme.fg("dim", " │ "),
            theme.fg(
              "warning",
              theme.bold(`★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`)
            ),
            bestRunNum > 0 ? theme.fg("dim", ` #${bestRunNum}`) : "",
          ];

          const optional: string[] = [];
          if (crashed > 0) optional.push(theme.fg("error", ` ${crashed}💥`));
          if (checksFailed > 0) optional.push(theme.fg("error", ` ${checksFailed}⚠`));

          if (baseline !== null && bestPrimary !== null && baseline !== 0 && bestPrimary !== baseline) {
            const pct = ((bestPrimary - baseline) / baseline) * 100;
            const sign = pct > 0 ? "+" : "";
            const deltaColor = isBetter(bestPrimary, baseline, state.bestDirection)
              ? "success"
              : "error";
            optional.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
          }

          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            const confColor: Parameters<typeof theme.fg>[0] = state.confidence >= 2.0 ? "success" : state.confidence >= 1.0 ? "warning" : "error";
            optional.push(theme.fg("dim", " │ "));
            optional.push(theme.fg(confColor, `conf: ${confStr}×`));
          }

          if (state.secondaryMetrics.length > 0) {
            for (const sm of state.secondaryMetrics) {
              const val = bestSec[sm.name];
              const bv = baselineSec[sm.name];
              if (val === undefined) continue;
              let secText = `${sm.name}: ${formatNum(val, sm.unit)}`;
              if (bv !== undefined && bv !== 0 && val !== bv) {
                const p = ((val - bv) / bv) * 100;
                const s = p > 0 ? "+" : "";
                const c = val <= bv ? "success" : "error";
                secText += theme.fg(c, ` ${s}${p.toFixed(1)}%`);
              }
              optional.push(theme.fg("dim", "  "));
              optional.push(theme.fg("muted", secText));
              break;
            }
          }

          if (state.name) optional.push(theme.fg("dim", ` │ ${state.name}`));

          const left = [...essential, ...optional].join("");
          return [
            appendRightAlignedAdaptiveHint(left, safeWidth, theme, [
              "ctrl+x expand • ctrl+shift+x fullscreen",
              "ctrl+x expand • full: c-s-x",
              "ctrl+x • c-s-x",
            ]),
          ];
        },
        invalidate(): void {},
      }));
    }
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async () => {
    clearOverlay();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    runtimeStore.clear(getSessionKey(ctx));
    stopDashboardServer();
  });

  // Reset per-session experiment counter when agent starts
  pi.on("agent_start", async (_event, ctx) => {
    getRuntime(ctx).experimentsThisSession = 0;
  });

  // Clear running experiment state when agent stops; check ideas file for continuation
  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.runningExperiment = null;
    if (overlayTui) overlayTui.requestRender();

    if (!runtime.autoresearchMode) return;

    // Don't auto-resume if no experiments ran this session (user likely stopped manually)
    if (runtime.experimentsThisSession === 0) return;

    // Rate-limit auto-resume to once every 5 minutes
    const now = Date.now();
    if (now - runtime.lastAutoResumeTime < 5 * 60 * 1000) return;
    runtime.lastAutoResumeTime = now;

    if (runtime.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      ctx.ui.notify(
        `Autoresearch auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
        "info"
      );
      return;
    }

    // Auto-continue: send a message to resume the loop
    // The agent reads autoresearch.md on startup which has all context
    const workDir = resolveWorkDir(ctx.cwd);
    const ideasPath = path.join(workDir, "autoresearch.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    let resumeMsg = "Autoresearch loop ended (likely context limit). Resume the experiment loop — read autoresearch.md and git log for context.";
    if (hasIdeas) {
      resumeMsg += " Check autoresearch.ideas.md for promising paths to explore. Prune stale/tried ideas.";
    }
    resumeMsg += ` ${BENCHMARK_GUARDRAIL}`;

    runtime.autoResumeTurns++;
    pi.sendUserMessage(resumeMsg);
  });

  // When in autoresearch mode, add a static note to the system prompt.
  // Only a short pointer — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.autoresearchMode) return;

    const workDir = resolveWorkDir(ctx.cwd);
    const mdPath = path.join(workDir, "autoresearch.md");
    const ideasPath = path.join(workDir, "autoresearch.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = path.join(workDir, "autoresearch.checks.sh");
    const hasChecks = fs.existsSync(checksPath);

    let extra =
      "\n\n## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
      "\nWrite promising but deferred optimizations as bullet points to autoresearch.ideas.md — don't let good ideas get lost." +
      `\n${BENCHMARK_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
        "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to autoresearch.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
      "If autoresearch.jsonl already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      refreshRuntimeConfig(runtime, ctx.cwd);

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const isReinit = state.results.length > 0;

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? "";
      if (params.direction === "lower" || params.direction === "higher") {
        state.bestDirection = params.direction;
      }
      // Start a new segment — keep history for dashboard, but reset baseline tracking.
      // Old results remain accessible (filtered by segment in rendering).
      if (isReinit) {
        state.currentSegment++;
      }
      state.bestMetric = null;
      state.secondaryMetrics = [];
      state.confidence = null;
      runtime.segmentStartedAt = Date.now();
      runtime.pausedByBudget = false;

      // Read max experiments from config file (config always in ctx.cwd)
      state.maxExperiments = readMaxExperiments(ctx.cwd);

      // Write config header to jsonl (append for re-init, create for first)
      const workDir = resolveWorkDir(ctx.cwd);
      try {
        const jsonlPath = path.join(workDir, AUTORESEARCH_STATE_FILE);
        const config = JSON.stringify({
          type: "config",
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        if (fs.existsSync(jsonlPath)) {
          fs.appendFileSync(jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(jsonlPath, config + "\n");
        }
        broadcastDashboardUpdate(workDir);
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`,
          }],
          details: {},
        };
      }

      runtime.autoresearchMode = true;
      clearPendingRun(runtime);
      transitionMachineState(runtime, AutoresearchMachineEvent.InitExperiment, "init_experiment called");
      runtime.iterationStartTokens = ctx.getContextUsage()?.tokens ?? null;
      updateWidget(ctx);

      const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
      const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from autoresearch.config.json)` : "";
      const workDirNote = workDir !== ctx.cwd ? `\nWorking directory: ${workDir}` : "";
      return {
        content: [{
          type: "text",
          text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to autoresearch.jsonl. Now run the baseline with run_experiment.`,
        }],
        details: { state: cloneExperimentState(state) },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result exactly once.",
      "Do not call run_experiment again until the previous run has been logged.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",

    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      refreshRuntimeConfig(runtime, ctx.cwd);

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);

      if (runtime.segmentStartedAt === null) {
        runtime.segmentStartedAt = Date.now();
      }

      if (runtime.pausedByBudget) {
        return {
          content: [{
            type: "text",
            text: `🛑 Autoresearch is paused by budget constraints. Re-run init_experiment to start a new segment before continuing.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            metricContractViolations: [],
            policyWarnings: [],
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      // Enforce run/log pairing lifecycle: one run must be logged before the next run.
      if (runtime.modeState === AutoresearchModeState.Running) {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.RunBlocked,
          "run requested while another run is in-flight"
        );
        return {
          content: [{
            type: "text",
            text: `⚠️ Cannot start a new run yet.
A benchmark is already running for run ID ${runtime.pendingRunId ?? "(none)"}. Please wait for it to finish before starting another.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      if (runtime.modeState === AutoresearchModeState.AwaitingLog) {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.RunBlocked,
          "run requested while previous run is pending log"
        );
        return {
          content: [{
            type: "text",
            text: `⚠️ Cannot start a new run yet.
A previous run must be logged first.

State: ${runtime.modeState}
Pending run ID: ${runtime.pendingRunId ?? "(none)"}

Please call log_experiment for the previous run (using the same run output context), then continue with run_experiment.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      if (runtime.modeState === AutoresearchModeState.Terminal) {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.RunBlocked,
          "run requested after terminal max reached"
        );
        return {
          content: [{
            type: "text",
            text: `🛑 Autoresearch loop reached its terminal limit. Run init_experiment to start a new segment before running again.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          transitionMachineState(runtime, AutoresearchMachineEvent.RunBlocked, "segment max reached");
          clearPendingRun(runtime);
          return {
            content: [{ type: "text", text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.` }],
            details: {},
          };
        }
      }

      // Guard budgets configured in autoresearch.config.json
      const budget = evaluateBudgetLimits(runtime);
      if (budget.blocked) {
        runtime.pausedByBudget = true;
        runtime.autoresearchMode = false;
        transitionMachineState(runtime, AutoresearchMachineEvent.MaxReached, budget.reason ?? "budget reached");
        return {
          content: [{
            type: "text",
            text: `🛑 Budget reached: ${budget.reason}. Autoresearch paused. Re-run init_experiment to start a new segment or relax budgets in autoresearch.config.json.`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            metricContractViolations: [],
            policyWarnings: [],
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      const timeout = (params.timeout_seconds ?? 600) * 1000;

      // Guard: command policy checks from config
      const policyCheck = evaluateCommandPolicy(params.command, runtime.policy);
      const policyWarnings = policyCheck.warning ? [policyCheck.warning] : [];
      if (policyCheck.blocked) {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.RunBlocked,
          "command policy violation"
        );
        clearPendingRun(runtime);
        return {
          content: [{
            type: "text",
            text: `❌ command blocked by autoresearch policy: ${policyCheck.warning}`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            metricContractViolations: [],
            policyWarnings,
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      // Guard: if autoresearch.sh exists, only allow running it
      const autoresearchShPath = path.join(workDir, "autoresearch.sh");
      if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(params.command)) {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.RunBlocked,
          "autoresearch.sh command guard"
        );
        clearPendingRun(runtime);
        return {
          content: [{
            type: "text",
            text: `❌ autoresearch.sh exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse: run_experiment({ command: "bash autoresearch.sh" }) or run_experiment({ command: "./autoresearch.sh" })`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            parsedMetrics: null,
            parsedPrimary: null,
            metricName: state.metricName,
            metricUnit: state.metricUnit,
            metricContractViolations: [],
            policyWarnings: ["autoresearch.sh exists"],
            runId: runtime.pendingRunId ?? undefined,
          } as RunDetails,
        };
      }

      const preRunSnapshot = gitStatusSnapshot(workDir);
      runtime.lastRunArtifactPreState = {
        command: params.command,
        startedAt: Date.now(),
        head: preRunSnapshot.head,
      };

      advanceIterationTracking(runtime, ctx);
      if (isContextExhausted(runtime, ctx)) {
        transitionMachineState(runtime, AutoresearchMachineEvent.RunBlocked, "context window exhausted");
        runtime.autoresearchMode = false;
        clearPendingRun(runtime);
        ctx.abort();
        return {
          content: [{ type: "text", text: "🛑 Context window almost full. Start a new pi session to continue — all progress is saved." }],
          details: {},
        };
      }

      transitionMachineState(
        runtime,
        AutoresearchMachineEvent.RunRequested,
        `run command: ${params.command}`
      );
      runtime.pendingRunId = newPendingRunId();
      runtime.lastRunSummary = null;
      runtime.runningExperiment = { startedAt: Date.now(), command: params.command };
      updateWidget(ctx);
      if (overlayTui) overlayTui.requestRender();

      const t0 = Date.now();

      // Spawn the process directly (like the bash tool) for streaming output
      const getTempFile = createTempFileAllocator();
      const { exitCode, killed: timedOut, output, tempFilePath: streamTempFile, actualTotalBytes } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
        tempFilePath: string | undefined;
        actualTotalBytes: number;
      }>((resolve, reject) => {
        let processTimedOut = false;

        const child = spawn("bash", ["-c", params.command], {
          cwd: workDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Rolling buffer for tail truncation (keep 2x what we need)
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        // Temp file for full output when it overflows
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        // Cache for Buffer.concat — only rebuild when chunks change
        let chunksGeneration = 0;
        let cachedGeneration = -1;
        let cachedText = "";

        function getBufferText(): string {
          if (cachedGeneration === chunksGeneration) return cachedText;
          cachedText = Buffer.concat(chunks).toString("utf-8");
          cachedGeneration = chunksGeneration;
          return cachedText;
        }

        // Timer interval — update every second with elapsed time + tail output
        const timerInterval = setInterval(() => {
          if (!onUpdate) return;
          const elapsed = formatElapsed(Date.now() - t0);
          const trunc = truncateTail(getBufferText(), {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          onUpdate({
            content: [{ type: "text", text: trunc.content || "" }],
            details: {
              phase: "running",
              elapsed,
              truncation: trunc.truncated ? trunc : undefined,
              fullOutputPath: tempFilePath,
            },
          });
        }, 1000);

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFile();
            tempFileStream = createWriteStream(tempFilePath);
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Evict old chunks, then trim the first surviving chunk to a line
          // boundary. This avoids splitting multi-byte UTF-8 characters that
          // straddle chunk boundaries (which would produce U+FFFD on decode).
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          // Trim first surviving chunk to a newline boundary
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a); // '\n'
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }

          chunksGeneration++;
        };

        if (child.stdout) child.stdout.on("data", handleData);
        if (child.stderr) child.stderr.on("data", handleData);

        // Timeout
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            if (child.pid) killTree(child.pid);
          }, timeout);
        }

        // Abort signal — kill immediately if pid exists, otherwise queue for spawn.
        // Using child.kill() as fallback ensures the signal is never silently swallowed.
        const onAbort = () => {
          if (child.pid) killTree(child.pid);
          else {
            // pid not yet assigned — try child.kill() which works without pid,
            // and also queue killTree for spawn in case child.kill() isn't enough
            // to clean up the full process tree.
            child.kill();
            child.once("spawn", () => { if (child.pid) killTree(child.pid); });
          }
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.on("error", (err) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();
          reject(err);
        });

        child.on("close", (code) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const fullBuffer = Buffer.concat(chunks);
          resolve({
            exitCode: code,
            killed: processTimedOut,
            output: fullBuffer.toString("utf-8"),
            tempFilePath,
            actualTotalBytes: totalBytes,
          });
        });
      }).finally(() => {
        runtime.runningExperiment = null;
        updateWidget(ctx);
        if (overlayTui) overlayTui.requestRender();
      });

      const durationSeconds = (Date.now() - t0) / 1000;
      runtime.lastRunDuration = durationSeconds;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const checksPath = path.join(workDir, "autoresearch.checks.sh");
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
        const ct0 = Date.now();
        try {
          const checksResult = await pi.exec("bash", [checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: workDir,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      // Store checks result for log_experiment gate
      runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

      const passed = benchmarkPassed && (checksPass === null || checksPass);

      // Reuse streaming temp file if it exists, otherwise create one for large output
      let fullOutputPath: string | undefined = streamTempFile;
      const totalLines = output.split("\n").length;
      if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
        fullOutputPath = getTempFile();
        fs.writeFileSync(fullOutputPath, output);
      }

      // Wider truncation for TUI display (details.tailOutput)
      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      // Tight truncation for LLM context (10 lines / 4KB)
      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Parse structured METRIC lines from output
      const parsedMetricMap = parseMetricLines(output);
      const parsedMetrics = parsedMetricMap.size > 0
        ? Object.fromEntries(parsedMetricMap)
        : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

      const metricContractViolations = evaluateMetricContract(
        state.metricName,
        parsedPrimary,
        parsedMetrics,
        runtime.metricContract
      );

      const postRunSnapshot = gitStatusSnapshot(workDir);
      const runId = runtime.pendingRunId ?? newPendingRunId();
      const artifact = createRunArtifactBundle(
        runId,
        params.command,
        workDir,
        runtime.lastRunArtifactPreState?.startedAt ?? Date.now(),
        Date.now(),
        preRunSnapshot,
        postRunSnapshot
      );
      const artifactPath = writeRunArtifact(artifact, runId);
      if (artifactPath) {
        artifact.artifactPath = artifactPath;
      }

      const details: RunDetails = {
        command: params.command,
        exitCode,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut,
        tailOutput: displayTruncation.content,
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        parsedMetrics,
        parsedPrimary,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
        metricContractViolations,
        policyWarnings,
        runId,
        artifactPath: artifactPath || undefined,
        runArtifact: artifact,
      };

      transitionMachineState(
        runtime,
        AutoresearchMachineEvent.RunCompleted,
        `exitCode=${exitCode} timedOut=${timedOut}`
      );
      runtime.lastRunSummary = details;

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (autoresearch.checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (autoresearch.checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      // Show parsed METRIC lines to the LLM
      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

        // Human-readable summary
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          // Infer unit from name suffix for display
          const sm = state.secondaryMetrics.find((m) => m.name === name);
          const unit = sm?.unit ?? "";
          text += ` ${name}=${formatNum(value, unit)}`;
        }

        // Machine-ready values for log_experiment (raw numbers, not formatted)
        text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
      }

      if (details.metricContractViolations.length > 0) {
        text += `\n⚠️ Metric contract violations: ${details.metricContractViolations.join("; ")}`;
      }

      if (details.policyWarnings.length > 0) {
        text += `\n⚠️ Policy warnings: ${details.policyWarnings.join("; ")}`;
      }

      if (artifactPath) {
        text += `\n🧾 Reproducibility artifact: ${artifactPath}`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === "lines") {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      return {
        content: [{ type: "text", text }],
        details: { ...details, truncation: llmTruncation.truncated ? llmTruncation : undefined, fullOutputPath },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const PREVIEW_LINES = 5;

      if (isPartial) {
        // Streaming: show elapsed timer + tail of output
        const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

        // Always show tail of streaming output (like bash tool shows preview lines)
        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return new Text(text, 0, 0);
      }

      const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      // Helper: append tail output preview or full output
      const appendOutput = (text: string, output: string): string => {
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      // Helper: format parsed primary metric suffix (empty string if not available)
      const parsedSuffix = d.parsedPrimary !== null
        ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
        : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("success", "✅ ");

      // Show wall-clock and parsed primary metric together
      const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
        } else {
          text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Call log_experiment only after run_experiment for the matching run (strictly one-to-one).",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to autoresearch.ideas.md. Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      refreshRuntimeConfig(runtime, ctx.cwd);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const secondaryMetrics = params.metrics ?? {};

      if (runtime.pausedByBudget) {
        return {
          content: [{
            type: "text",
            text: `🛑 Autoresearch is paused by budget constraints. Re-run init_experiment or adjust autoresearch.config.json budget limits.`,
          }],
          details: {
            experiment: {
              commit: shortCommit(params.commit),
              metric: params.metric,
              metrics: secondaryMetrics,
              status: params.status,
              description: params.description,
              timestamp: Date.now(),
              segment: state.currentSegment,
              confidence: null,
              iterationTokens: null,
              schemaVersion: AUTORESEARCH_SCHEMA_VERSION,
            },
            state: cloneExperimentState(state),
            wallClockSeconds: runtime.lastRunDuration,
            budgetCheck: {
              paused: true,
              reason: "paused by budget limits",
            },
          },
        };
      }

      // Enforce strict run/log pairing (one run must be completed before logging).
      const pendingRunId = runtime.pendingRunId;
      if (
        runtime.modeState !== AutoresearchModeState.AwaitingLog ||
        !pendingRunId ||
        !runtime.lastRunSummary ||
        runtime.lastRunSummary.runId !== pendingRunId
      ) {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.RunBlocked,
          "log_experiment called without matching pending run"
        );
        return {
          content: [{
            type: "text",
            text: `❌ Invalid log_experiment call order.

log_experiment can only be called immediately after run_experiment (one-to-one).
No matching pending run was found.

Current state: ${runtime.modeState}
Pending run ID: ${runtime.pendingRunId ?? "(none)"}

Please call run_experiment first, then call log_experiment with the run result.`,
          }],
          details: {
            modeState: runtime.modeState,
            pendingRunId: runtime.pendingRunId,
            hasRunSummary: !!runtime.lastRunSummary,
          },
        };
      }

      // Idempotency: avoid double-logging the same run
      if (runtime.loggedRunIds.has(pendingRunId)) {
        const existingIndex = state.results.findLastIndex((r) => r.runId === pendingRunId);
        return {
          content: [{
            type: "text",
            text: `✅ This run ID (${pendingRunId}) was already logged in this session. Duplicate log_experiment calls are ignored to preserve idempotency.`,
          }],
          details: {
            experiment: (state.results[existingIndex] ?? runtime.lastRunSummary) as unknown as ExperimentResult,
            state: cloneExperimentState(state),
            wallClockSeconds: runtime.lastRunDuration,
          },
        };
      }

      const usage = ctx.getContextUsage();
      if (usage?.tokens != null) {
        recordIterationTokens(runtime, usage.tokens);
        runtime.iterationStartTokens = usage.tokens;
      }

      // Gate: enforce metric contract before accepting keep/logs.
      const summary = runtime.lastRunSummary;
      const contractViolations = summary?.metricContractViolations ?? [];
      if (params.status === "keep" && contractViolations.length > 0) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep this run due to contract violations: ${contractViolations.join("; ")}\n\nEither log with status='discard' or update your benchmark output to emit required metrics.`,
          }],
          details: {},
        };
      }

      // Gate: prevent "keep" when last run's checks failed
      if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep — autoresearch.checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
          }],
          details: {},
        };
      }

      // Gate: enforce policy on file changes for successful keep attempts
      if (params.status === "keep" && summary?.runArtifact) {
        const changedCount = new Set([
          ...summary.runArtifact.modifiedFiles,
          ...summary.runArtifact.addedFiles,
          ...summary.runArtifact.deletedFiles,
          ...summary.runArtifact.untrackedFiles,
        ]).size;
        if (runtime.policy.maxModifiedFilesPerRun !== null && changedCount > runtime.policy.maxModifiedFilesPerRun) {
          const message = `Keep blocked by policy: ${changedCount} changed files exceeds maxModifiedFilesPerRun=${runtime.policy.maxModifiedFilesPerRun}`;
          if (!runtime.policy.allowSoftViolations) {
            return {
              content: [{ type: "text", text: `❌ ${message}\n\nLog this run as 'discard' or update policy limits.` }],
              details: {
                metricContractViolations: [message],
                policyWarnings: [message],
              },
            };
          }
          // Soft violation: keep allowed but warn in ASI.
          if (!params.asi) params.asi = {};
          params.asi["policyWarnings"] = [message];
          if (runtime.lastRunSummary) {
            runtime.lastRunSummary.policyWarnings = [
              ...(runtime.lastRunSummary.policyWarnings ?? []),
              message,
            ];
          }
        }
      }

      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        // Check for missing metrics
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
            }],
            details: {},
          };
        }

        // Check for new metrics not yet tracked
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [{
              type: "text",
              text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
            }],
            details: {},
          };
        }
      }

      // ASI: agent-supplied free-form diagnostics
      const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
        ? params.asi as ASI
        : undefined;

      const runWarnings = [
        ...(summary?.metricContractViolations ?? []),
        ...(summary?.policyWarnings ?? []),
      ];
      const mergedASIWithWarnings = ((): ASI | undefined => {
        if (!runWarnings.length && !mergedASI) return undefined;
        const next: ASI = mergedASI ? { ...mergedASI } : {};
        if (runWarnings.length > 0) {
          next.policyWarnings = runWarnings;
        }
        return next;
      })();

      const iterationTokens = lastIterationTokens(runtime);
      const objectiveResult = evaluateObjectives(state, params.metric, secondaryMetrics);

      if (params.status === "keep" && objectiveResult.violations.length > 0) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep this run — objective constraints not satisfied: ${objectiveResult.violations
              .map((x) => `${x.metric} ${x.reason} ${x.expected} (actual=${x.actual})`)
              .join("; ")}. Log this run as 'discard' and inspect constraints.`,
          }],
          details: {},
        };
      }

      const experiment: ExperimentResult = {
        commit: params.commit.slice(0, 7),
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status,
        description: params.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        confidence: null,
        iterationTokens,
        asi: mergedASIWithWarnings,
        schemaVersion: AUTORESEARCH_SCHEMA_VERSION,
        runId: summary?.runId,
        artifactPath: summary?.artifactPath,
        objectiveScore: objectiveResult.score,
        objectiveViolations: objectiveResult.violations,
      };

      state.results.push(experiment);
      runtime.experimentsThisSession++;
      if (experiment.runId) {
        runtime.loggedRunIds.add(experiment.runId);
      }

      // Register any new secondary metric names
      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          let unit = "";
          if (name.endsWith("µs")) unit = "µs";
          else if (name.endsWith("_ms")) unit = "ms";
          else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
          else if (name.endsWith("_kb")) unit = "kb";
          else if (name.endsWith("_mb")) unit = "mb";
          state.secondaryMetrics.push({ name, unit });
        }
      }

      // Baseline = first run in current segment
      state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

      // Compute confidence score (best improvement as multiple of noise floor)
      state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
      experiment.confidence = state.confidence;

      // Build response text
      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
          const delta = params.metric - state.bestMetric;
          const pct = ((delta / state.bestMetric) * 100).toFixed(1);
          const sign = delta > 0 ? "+" : "";
          text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }

      if (experiment.objectiveScore !== null && experiment.objectiveScore !== undefined) {
        text += `\nObjective score: ${experiment.objectiveScore.toFixed(4)}`;
      }

      if (summary?.artifactPath) {
        text += `\nArtifact: ${summary.artifactPath}`;
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? "+" : "";
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      // Show ASI summary
      if (mergedASIWithWarnings) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(mergedASIWithWarnings)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
        }
        if (asiParts.length > 0) {
          text += `\n📋 ASI: ${asiParts.join(" | ")}`;
        }
      }

      // Show confidence score
      if (state.confidence !== null) {
        const confStr = state.confidence.toFixed(1);
        if (state.confidence >= 2.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
        } else if (state.confidence >= 1.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
        } else {
          text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
        }
      }

      text += `\n(${segmentCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;

      // Auto-commit only on keep — discards/crashes get reverted anyway
      if (params.status === "keep") {
        try {
          const resultData: Record<string, unknown> = {
            status: params.status,
            [state.metricName || "metric"]: params.metric,
            ...secondaryMetrics,
          };
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;

          const execOpts = { cwd: workDir, timeout: 10000 };
          const addResult = await pi.exec("git", ["add", "-A"], execOpts);
          if (addResult.code !== 0) {
            const addErr = (addResult.stdout + addResult.stderr).trim();
            throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
          }

          const diffResult = await pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
          if (diffResult.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const gitResult = await pi.exec("git", ["commit", "-m", commitMsg], execOpts);
            const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
            if (gitResult.code === 0) {
              const firstLine = gitOutput.split("\n")[0] || "";
              text += `\n📝 Git: committed — ${firstLine}`;

              try {
                const shaResult = await pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 });
                const newSha = (shaResult.stdout || "").trim();
                if (newSha && newSha.length >= 7) {
                  experiment.commit = newSha;
                }
              } catch {
                // Keep the original commit hash if rev-parse fails
              }
            } else {
              text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Persist to autoresearch.jsonl (always, regardless of status)
      try {
        const jsonlPath = path.join(workDir, AUTORESEARCH_STATE_FILE);
        const jsonlEntry: Record<string, unknown> = {
          run: state.results.length,
          ...experiment,
        };
        // Only write asi if present (keep lines compact when no ASI)
        if (!mergedASIWithWarnings) delete jsonlEntry.asi;
        fs.appendFileSync(jsonlPath, JSON.stringify(jsonlEntry) + "\n");
        broadcastDashboardUpdate(workDir);
      } catch (e) {
        text += `\n⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Auto-revert on discard/crash/checks_failed — revert all files except autoresearch session files
      if (params.status !== "keep") {
        try {
          const protectedFiles = ["autoresearch.jsonl", "autoresearch.md", "autoresearch.ideas.md", "autoresearch.sh", "autoresearch.checks.sh"];
          const stageCmd = protectedFiles.map((f) => `git add "${path.join(workDir, f)}" 2>/dev/null || true`).join("; ");
          await pi.exec("bash", ["-c", `${stageCmd}; git checkout -- .; git clean -fd 2>/dev/null`], { cwd: workDir, timeout: 10000 });
          text += `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
        } catch (e) {
          text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Clear running experiment and checks state (log_experiment consumes the run)
      const wallClockSeconds = runtime.lastRunDuration;
      runtime.runningExperiment = null;
      runtime.lastRunChecks = null;
      runtime.lastRunDuration = null;
      clearPendingRun(runtime);

      // Check budget constraints after logging
      const budgetCheck = evaluateBudgetLimits(runtime);
      const budgetPaused = budgetCheck.blocked;
      if (budgetPaused) {
        runtime.pausedByBudget = true;
        runtime.autoresearchMode = false;
      }

      // Check if max experiments limit reached
      const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
      if (limitReached || budgetPaused) {
        const terminalReason = budgetPaused
          ? `budget reached: ${budgetCheck.reason}`
          : `segment max reached: ${state.maxExperiments}`;
        if (budgetPaused) {
          text += `\n\n🛑 Budget reached (${budgetCheck.reason}). Autoresearch paused.`;
        } else {
          text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        }
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.MaxReached,
          terminalReason
        );
        ctx.abort();
      } else {
        transitionMachineState(
          runtime,
          AutoresearchMachineEvent.LogApplied,
          `logged status=${params.status}`
        );
      }

      updateWidget(ctx);

      // Refresh fullscreen overlay if open
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text }],
        details: {
          experiment: { ...experiment, metrics: { ...experiment.metrics } },
          state: cloneExperimentState(state),
          wallClockSeconds,
          budgetCheck: budgetPaused
            ? {
                paused: true,
                reason: budgetCheck.reason ?? "budget reached",
              }
            : undefined,
          runArtifact: summary?.runArtifact,
        } as LogDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context (overall best, not just this run)
      if (s.bestMetric !== null) {
        // Find the actual best kept metric in the current segment
        let best = s.bestMetric;
        for (const r of s.results) {
          if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      if (exp.objectiveScore !== null && exp.objectiveScore !== undefined) {
        text += theme.fg("dim", `  objective=${exp.objectiveScore.toFixed(3)}`);
      }

      if (exp.objectiveViolations && exp.objectiveViolations.length > 0) {
        text += theme.fg("warning", `  objective-violations=${exp.objectiveViolations.length}`);
      }

      if (exp.artifactPath) {
        text += theme.fg("dim", `  artifact=${exp.artifactPath}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Ctrl+X — toggle dashboard expand/collapse
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+x", {
    description: "Toggle autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      if (state.results.length === 0) {
        if (!runtime.autoresearchMode && !fs.existsSync(path.join(resolveWorkDir(ctx.cwd), "autoresearch.md"))) {
          ctx.ui.notify("No experiments yet — run /autoresearch to get started", "info");
        } else {
          ctx.ui.notify("No experiments yet", "info");
        }
        return;
      }
      runtime.dashboardExpanded = !runtime.dashboardExpanded;
      updateWidget(ctx);
    },
  });

  // -----------------------------------------------------------------------
  // Ctrl+Shift+X — fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+shift+x", {
    description: "Fullscreen autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      if (state.results.length === 0) {
        ctx.ui.notify("No experiments yet", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          let scrollOffset = 0;
          let lastViewportRows = 8;
          let lastTotalRows = 0;
          overlayTui = tui;

          spinnerInterval = setInterval(() => {
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            if (runtime.runningExperiment) tui.requestRender();
          }, 80);

          const buildOverlayContent = (renderWidth: number): string[] => {
            const content = renderDashboardLines(state, renderWidth, theme, 0);
            if (runtime.runningExperiment) {
              const elapsed = formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
              const frame = SPINNER[spinnerFrame % SPINNER.length];
              const nextIdx = state.results.length + 1;
              content.push(
                truncateToWidth(
                  `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                    theme.fg("warning", `${frame} running… ${elapsed}`),
                  renderWidth,
                  "…",
                  true
                )
              );
            }
            return content;
          };

          return {
            render(width: number): string[] {
              const { height } = getTuiSize(tui);
              const safeWidth = Math.max(1, width || getTuiSize(tui).width);
              const viewportRows = Math.max(4, height - 4);
              const content = buildOverlayContent(safeWidth);

              const totalRows = content.length;
              const maxScroll = Math.max(0, totalRows - viewportRows);
              scrollOffset = clamp(scrollOffset, 0, maxScroll);
              lastViewportRows = viewportRows;
              lastTotalRows = totalRows;

              const out: string[] = [];

              const title = truncateDisplayText(
                `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
                Math.max(0, safeWidth - 5)
              );
              const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);

              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "───") +
                    theme.fg("accent", ` ${title} `) +
                    theme.fg("borderMuted", "─".repeat(fillLen)),
                  safeWidth,
                  "…",
                  true
                )
              );

              const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
              for (const line of visible) out.push(truncateToWidth(line, safeWidth, "…", true));
              for (let i = visible.length; i < viewportRows; i++) out.push("");

              const scrollInfo = totalRows > viewportRows
                ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
                : "";
              const helpText = safeWidth >= 85
                ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
                : ` j/k scroll • esc close${scrollInfo} `;
              const footFill = Math.max(0, safeWidth - visibleWidth(helpText));

              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "─".repeat(footFill)) + theme.fg("dim", helpText),
                  safeWidth,
                  "…",
                  true
                )
              );

              return out;
            },

            handleInput(data: string): void {
              const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

              if (matchesKey(data, "escape") || data === "q") {
                done(undefined);
                return;
              }
              if (matchesKey(data, "up") || data === "k") {
                scrollOffset = Math.max(0, scrollOffset - 1);
              } else if (matchesKey(data, "down") || data === "j") {
                scrollOffset = Math.min(maxScroll, scrollOffset + 1);
              } else if (matchesKey(data, "pageUp") || data === "u") {
                scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
              } else if (matchesKey(data, "pageDown") || data === "d") {
                scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
              } else if (data === "g") {
                scrollOffset = 0;
              } else if (data === "G") {
                scrollOffset = maxScroll;
              }
              tui.requestRender();
            },

            invalidate(): void {},

            dispose(): void {
              clearOverlay();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "95%",
            maxHeight: "90%",
            anchor: "center" as const,
          },
        }
      );
    },
  });

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
  const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

  let cachedPackageRoot: string | null = null;

  function packageRoot(): string {
    if (cachedPackageRoot) return cachedPackageRoot;
    const extensionDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    cachedPackageRoot = path.resolve(extensionDir, "../..");
    return cachedPackageRoot;
  }

  function templatePath(): string {
    return path.join(packageRoot(), "assets/template.html");
  }

  function readTemplate(): string {
    return fs.readFileSync(templatePath(), "utf-8");
  }

  let cachedLogoDataUrl: string | null = null;

  function logoDataUrl(): string {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    const logoPath = path.join(packageRoot(), "assets/logo.webp");
    const bytes = fs.readFileSync(logoPath);
    cachedLogoDataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
    return cachedLogoDataUrl;
  }

  function readJsonlContent(workDir: string): string {
    return fs.readFileSync(path.join(workDir, AUTORESEARCH_STATE_FILE), "utf-8").trim();
  }

  function extractSessionName(jsonlContent: string): string {
    const firstLine = jsonlContent.split("\n").find((l) => l.trim());
    if (!firstLine) return "Autoresearch";
    try {
      const config = JSON.parse(firstLine);
      return config.name || "Autoresearch";
    } catch {
      return "Autoresearch";
    }
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectDataIntoTemplate(template: string, title: string): string {
    const escapedTitle = escapeHtml(title);
    return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
  }

  let dashboardServer: Server | null = null;
  let dashboardServerPort: number | null = null;
  let dashboardServerWorkDir: string | null = null;
  let dashboardServerHtmlPath: string | null = null;
  const dashboardSseClients = new Set<ServerResponse>();

  function openInBrowser(url: string): void {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        shell: true,
        stdio: "ignore",
      }).unref();
      return;
    }

    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(openCmd, [url], { detached: true, stdio: "ignore" }).unref();
  }

  function stopDashboardServer(): void {
    for (const client of dashboardSseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    dashboardSseClients.clear();

    if (dashboardServer) {
      try { dashboardServer.close(); } catch { /* ignore */ }
    }

    dashboardServer = null;
    dashboardServerPort = null;
    dashboardServerWorkDir = null;
    dashboardServerHtmlPath = null;
  }

  function writeDashboardFile(workDir: string): string {
    const jsonlContent = readJsonlContent(workDir);
    const sessionName = extractSessionName(jsonlContent);
    const html = injectDataIntoTemplate(readTemplate(), sessionName)
      .replace(LOGO_PLACEHOLDER, logoDataUrl());
    const exportDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-dashboard-"));
    const dest = path.join(exportDir, "index.html");
    fs.writeFileSync(dest, html);
    return dest;
  }

  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".jsonl": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
  };

  function fileContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  function resolveServedFile(workDir: string, requestPath: string): string | null {
    if (requestPath === "/") return dashboardServerHtmlPath;
    if (requestPath === "/autoresearch.jsonl") return path.join(workDir, AUTORESEARCH_STATE_FILE);
    return null;
  }

  function registerSseClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    dashboardSseClients.add(res);
    res.on("close", () => dashboardSseClients.delete(res));
  }

  function broadcastDashboardUpdate(workDir: string): void {
    if (!dashboardServer || dashboardServerWorkDir !== workDir) return;
    for (const res of dashboardSseClients) {
      try {
        res.write("event: jsonl-updated\n");
        res.write(`data: ${Date.now()}\n\n`);
      } catch {
        dashboardSseClients.delete(res);
      }
    }
  }

  function startStaticServer(workDir: string, dashboardHtmlPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const resolvedWorkDir = path.resolve(workDir);
      const resolvedDashboardHtmlPath = path.resolve(dashboardHtmlPath);

      if (dashboardServer && dashboardServerWorkDir === resolvedWorkDir && dashboardServerPort) {
        dashboardServerHtmlPath = resolvedDashboardHtmlPath;
        resolve(dashboardServerPort);
        return;
      }

      stopDashboardServer();
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/events") {
          registerSseClient(res);
          return;
        }

        const filePath = resolveServedFile(resolvedWorkDir, url.pathname);
        if (!filePath) {
          res.writeHead(404);
          res.end();
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": fileContentType(filePath) });
          res.end(data);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind dashboard server"));
          return;
        }
        dashboardServer = server;
        dashboardServerPort = address.port;
        dashboardServerWorkDir = resolvedWorkDir;
        resolve(address.port);
      });

      server.on("error", reject);
    });
  }

  async function exportDashboard(ctx: ExtensionContext): Promise<void> {
    const workDir = resolveWorkDir(ctx.cwd);
    const jsonlPath = path.join(workDir, AUTORESEARCH_STATE_FILE);

    if (!fs.existsSync(jsonlPath)) {
      ctx.ui.notify("No autoresearch.jsonl found \u2014 run some experiments first", "error");
      return;
    }

    try {
      const dashboardHtmlPath = writeDashboardFile(workDir);
      const port = await startStaticServer(workDir, dashboardHtmlPath);
      const url = `http://127.0.0.1:${port}`;
      openInBrowser(url);
      ctx.ui.notify(`Dashboard at ${url} (live updates)`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  // -----------------------------------------------------------------------
  // /autoresearch command — enter autoresearch mode
  // -----------------------------------------------------------------------

  pi.registerCommand("autoresearch", {
    description: "Start, stop, clear, or resume autoresearch mode",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      refreshRuntimeConfig(runtime, ctx.cwd);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(autoresearchHelp(), "info");
        return;
      }

      if (command === "off") {
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.runningExperiment = null;
        runtime.pausedByBudget = false;
        runtime.segmentStartedAt = null;
        clearPendingRun(runtime);
        transitionMachineState(runtime, AutoresearchMachineEvent.ModeOff, "user /autoresearch off");
        stopDashboardServer();
        clearSessionUi(ctx);
        ctx.ui.notify("Autoresearch mode OFF", "info");
        return;
      }

      if (command === "export") {
        await exportDashboard(ctx);
        return;
      }

      if (command === "clear") {
        const jsonlPath = path.join(resolveWorkDir(ctx.cwd), AUTORESEARCH_STATE_FILE);
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.runningExperiment = null;
        runtime.pausedByBudget = false;
        runtime.segmentStartedAt = null;
        runtime.loggedRunIds = new Set();
        clearPendingRun(runtime);
        transitionMachineState(runtime, AutoresearchMachineEvent.Clear, "user /autoresearch clear");
        runtime.state = createExperimentState();
        const obj = readObjectives(ctx.cwd);
        runtime.state.objectiveWeights = obj.metricWeights;
        runtime.state.objectiveConstraints = obj.constraints;
        stopDashboardServer();
        updateWidget(ctx);

        if (fs.existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
            ctx.ui.notify("Deleted autoresearch.jsonl and turned autoresearch mode OFF", "info");
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete autoresearch.jsonl: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
          }
        } else {
          ctx.ui.notify("No autoresearch.jsonl found. Autoresearch mode OFF", "info");
        }
        return;
      }

      if (runtime.autoresearchMode) {
        ctx.ui.notify("Autoresearch already active — use '/autoresearch off' to stop first", "info");
        return;
      }

      runtime.autoresearchMode = true;
      runtime.autoResumeTurns = 0;
      transitionMachineState(runtime, AutoresearchMachineEvent.ModeOn, `user /autoresearch ${trimmedArgs}`);

      const mdPath = path.join(resolveWorkDir(ctx.cwd), "autoresearch.md");
      const hasRules = fs.existsSync(mdPath);

      if (hasRules) {
        ctx.ui.notify("Autoresearch mode ON — rules loaded from autoresearch.md", "info");
        pi.sendUserMessage(`Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`);
      } else {
        ctx.ui.notify("Autoresearch mode ON — no autoresearch.md found, setting up", "info");
        pi.sendUserMessage(
          `Start autoresearch: ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        );
      }
    },
  });
}
