import { createHash } from 'node:crypto';
import path from 'node:path';
import { Sandbox } from '@superserve/sdk';
import type { Config } from '../config.ts';
import { scoreEncounter, scoreTactics, type EncounterBlueprint, type EncounterPlan, type RehearsalEpisode, type RehearsalResult, type RehearsalStrategy } from '../tactics.ts';

/**
 * Tactic rehearsal after a banishment and encounter planning for an echo trial, both outside the tick.
 * `superserve` runs the fixed scorer (src/tactics.ts, transpiled) inside a real Firecracker microVM with
 * @superserve/sdk: create sandbox, write files, run node, kill in `finally`. One sandbox per unique job,
 * never per tick; results are cached by input hash so a replayed transition never creates another VM.
 * It is gated by SUPERSERVE_API_KEY *and* SUPERSERVE_REHEARSAL=1 because sandboxes bill; otherwise the
 * identical scorer runs in-process as `local-scoring`. The room clamps and validates every result.
 */
export type RehearsalMode = 'superserve' | 'superserve-disabled' | 'local-scoring';
export type Executor = 'superserve' | 'local';

export interface RehearsalOutcome extends RehearsalResult {
  executor: Executor;
  durationMs: number;
}

export interface PlanOutcome extends EncounterPlan {
  executor: Executor;
  durationMs: number;
  cached: boolean;
}

export interface Rehearsal {
  mode(): RehearsalMode;
  run(episode: RehearsalEpisode): Promise<RehearsalOutcome>;
  plan(blueprint: EncounterBlueprint): Promise<PlanOutcome>;
  status(): Record<string, unknown>;
}

const ALLOWED: RehearsalStrategy[] = ['chase', 'flank', 'keep_distance', 'ambush'];
const LIMITS = { hpMul: 1.5, speedMul: 1.3, aggroBonus: 4 };
const SANDBOX_BUDGET_MS = 60_000;
const MAX_PLAN_CACHE = 32;
const TACTICS_SOURCE = path.resolve(import.meta.dir, '../tactics.ts');
const RUNNER = `import { readFileSync } from 'node:fs';
import { scoreEncounter, scoreTactics } from './tactics.mjs';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(Array.isArray(input.enemies) ? scoreEncounter(input) : scoreTactics(input)));
`;

const validateTactic = (raw: unknown, ep: RehearsalEpisode): RehearsalResult => {
  const r = raw as Partial<RehearsalResult>;
  if (!r || typeof r !== 'object' || !ALLOWED.includes(r.strategy as RehearsalStrategy) || !ep.strategies.includes(r.strategy as RehearsalStrategy)) {
    throw new Error('rehearsal returned an invalid strategy');
  }
  return { strategy: r.strategy as RehearsalStrategy, scores: r.scores ?? ({} as RehearsalResult['scores']), rationale: String(r.rationale ?? '').slice(0, 300) };
};

const clampNum = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Trust boundary for anything that came back from a sandbox: known enemies, allowed tactics, bounded scaling. */
const validatePlan = (raw: unknown, bp: EncounterBlueprint): EncounterPlan => {
  const r = raw as Partial<EncounterPlan>;
  if (!r || typeof r !== 'object' || r.echo !== bp.echo || !Array.isArray(r.enemies)) throw new Error('encounter plan is malformed');
  const enemies = bp.enemies.map((e) => {
    const entry = r.enemies!.find((x) => x && x.id === e.id) as Partial<EncounterPlan['enemies'][number]> | undefined;
    const strategy = entry && ALLOWED.includes(entry.strategy as RehearsalStrategy) && e.strategies.includes(entry.strategy as RehearsalStrategy) ? (entry.strategy as RehearsalStrategy) : e.strategies[0] ?? 'chase';
    return { id: e.id, strategy, hpMul: clampNum(entry?.hpMul, 1, LIMITS.hpMul), speedMul: clampNum(entry?.speedMul, 1, LIMITS.speedMul), aggroBonus: clampNum(entry?.aggroBonus, 0, LIMITS.aggroBonus) };
  });
  return { echo: bp.echo, enemies, rationale: String(r.rationale ?? '').slice(0, 300) };
};

const blueprintKey = (bp: EncounterBlueprint) => `${bp.echo}:${createHash('sha256').update(JSON.stringify(bp)).digest('hex').slice(0, 16)}`;

class LocalRehearsal implements Rehearsal {
  private runs = 0;
  private plans = 0;
  constructor(private readonly reason: RehearsalMode) {}
  mode(): RehearsalMode {
    return this.reason;
  }
  async run(episode: RehearsalEpisode): Promise<RehearsalOutcome> {
    const start = performance.now();
    this.runs += 1;
    return { ...validateTactic(scoreTactics(episode), episode), executor: 'local', durationMs: Math.round(performance.now() - start) };
  }
  async plan(blueprint: EncounterBlueprint): Promise<PlanOutcome> {
    const start = performance.now();
    this.plans += 1;
    return { ...validatePlan(scoreEncounter(blueprint), blueprint), executor: 'local', durationMs: Math.round(performance.now() - start), cached: false };
  }
  status(): Record<string, unknown> {
    return { mode: this.mode(), runs: this.runs, plans: this.plans, note: this.reason === 'superserve-disabled' ? 'SUPERSERVE_API_KEY present; set SUPERSERVE_REHEARSAL=1 to run in microVMs' : 'SUPERSERVE_API_KEY missing' };
  }
}

class SuperserveRehearsal implements Rehearsal {
  private readonly local = new LocalRehearsal('local-scoring');
  private readonly planCache = new Map<string, Promise<PlanOutcome>>();
  private tacticsJs: Promise<string> | null = null;
  private runs = 0;
  private plans = 0;
  private failures = 0;
  private lastError = '';
  private lastSandboxId = '';
  private sandboxesCreated = 0;
  private sandboxesKilled = 0;
  private running = 0;

  constructor(private readonly apiKey: string, private readonly template: string) {}

  mode(): RehearsalMode {
    return 'superserve';
  }

  private script(): Promise<string> {
    this.tacticsJs ??= Bun.file(TACTICS_SOURCE)
      .text()
      .then((ts) => new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(ts));
    return this.tacticsJs;
  }

  /** Runs the fixed scorer on one JSON input inside a fresh microVM; the sandbox is always killed. */
  private async inSandbox(name: string, input: unknown): Promise<unknown> {
    const js = await this.script();
    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), SANDBOX_BUDGET_MS);
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await Sandbox.create({
        name,
        apiKey: this.apiKey,
        fromTemplate: this.template,
        timeoutSeconds: 120,
        autoDeleteSeconds: 0,
        metadata: { app: 'issekaied', job: name },
        signal: controller.signal,
      });
      this.sandboxesCreated += 1;
      this.lastSandboxId = sandbox.id;
      await sandbox.files.write('/tmp/tactics.mjs', js);
      await sandbox.files.write('/tmp/run.mjs', RUNNER);
      await sandbox.files.write('/tmp/input.json', JSON.stringify(input));
      const result = await sandbox.commands.run('node /tmp/run.mjs /tmp/input.json', { timeoutMs: 30_000, signal: controller.signal });
      if (result.exitCode !== 0) throw new Error(`sandbox exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`);
      return JSON.parse(result.stdout);
    } finally {
      clearTimeout(budget);
      if (sandbox) {
        await sandbox.kill().then(() => (this.sandboxesKilled += 1)).catch((err) => (this.lastError = `kill: ${(err as Error).message}`.slice(0, 200)));
      }
    }
  }

  async run(episode: RehearsalEpisode): Promise<RehearsalOutcome> {
    if (this.running >= 1) return this.local.run(episode); // one microVM at a time for a hackathon budget
    const start = performance.now();
    this.running += 1;
    try {
      const outcome = validateTactic(await this.inSandbox(`issekaied-rehearsal-${episode.ghostId}`, episode), episode);
      this.runs += 1;
      return { ...outcome, executor: 'superserve', durationMs: Math.round(performance.now() - start) };
    } catch (err) {
      this.failures += 1;
      this.lastError = (err as Error).message.slice(0, 200);
      return this.local.run(episode);
    } finally {
      this.running -= 1;
    }
  }

  plan(blueprint: EncounterBlueprint): Promise<PlanOutcome> {
    const key = blueprintKey(blueprint);
    const hit = this.planCache.get(key);
    if (hit) return hit.then((p) => ({ ...p, cached: true }));
    const job = (async (): Promise<PlanOutcome> => {
      const start = performance.now();
      this.running += 1;
      try {
        const plan = validatePlan(await this.inSandbox(`issekaied-echo-${blueprint.echo}`, blueprint), blueprint);
        this.plans += 1;
        return { ...plan, executor: 'superserve', durationMs: Math.round(performance.now() - start), cached: false };
      } catch (err) {
        this.failures += 1;
        this.lastError = (err as Error).message.slice(0, 200);
        this.planCache.delete(key); // do not cache a failure
        return this.local.plan(blueprint);
      } finally {
        this.running -= 1;
      }
    })();
    this.planCache.set(key, job);
    if (this.planCache.size > MAX_PLAN_CACHE) this.planCache.delete(this.planCache.keys().next().value as string);
    return job;
  }

  status(): Record<string, unknown> {
    return {
      mode: this.mode(),
      template: this.template,
      runs: this.runs,
      plans: this.plans,
      cachedPlans: this.planCache.size,
      sandboxesCreated: this.sandboxesCreated,
      sandboxesKilled: this.sandboxesKilled,
      failures: this.failures,
      lastSandboxId: this.lastSandboxId || undefined,
      lastError: this.lastError || undefined,
      localFallback: this.local.status(),
    };
  }
}

export function createRehearsal(cfg: Config): Rehearsal {
  if (!cfg.superserve.apiKey) return new LocalRehearsal('local-scoring');
  if (!cfg.superserve.rehearsal) return new LocalRehearsal('superserve-disabled');
  return new SuperserveRehearsal(cfg.superserve.apiKey, cfg.superserve.template);
}

/** Exposed for tests: the exact JS that would be shipped into the sandbox. */
export const transpiledTactics = async (): Promise<string> => new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(await Bun.file(TACTICS_SOURCE).text());
export const sandboxRunner = RUNNER;
