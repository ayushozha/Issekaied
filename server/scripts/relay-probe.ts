/**
 * Real Agent Relay delivery probe on PROBE-ONLY participants and channels. It never joins or posts to the
 * game channels (#hivemind / #pantheon): it registers `issekaied-probe-hivemind` / `issekaied-probe-pantheon`,
 * joins `issekaied-probe-hivemind` / `issekaied-probe-pantheon`, sends one warning and one pantheon note
 * flagged `testOnly`, and reports whether a *distinct registered participant* received each over Relay.
 * The local echo fallback is counted as a failure here, never as success.
 *
 *   bun --env-file=<abs path to root .env> server/scripts/relay-probe.ts
 */
import path from 'node:path';
import { config, type Config } from '../src/config.ts';
import { createChannels } from '../src/integrations/relay.ts';

const dataDir = path.resolve(import.meta.dir, '../../output/phase2-relay-probe');
const cfg: Config = { ...config, dataDir };
if (!cfg.relay.workspaceKey) {
  console.log('RELAY_WORKSPACE_KEY is not set in this process environment; nothing to probe.');
  process.exit(2);
}
const PROBE_NAMES = { hivemind: 'issekaied-probe-hivemind', pantheon: 'issekaied-probe-pantheon', agentPrefix: 'issekaied-probe' };
let channels = createChannels(cfg, PROBE_NAMES);
const got: string[] = [];
channels.onWarning((w, via) => got.push(`warning:${w.eventId}:${via}:${w.testOnly ? 'testOnly' : 'canonical'}`));
channels.onPantheon((n, via) => got.push(`pantheon:${n.eventId}:${via}:${n.testOnly ? 'testOnly' : 'canonical'}`));

const t0 = Date.now();
// Relay registration can answer "temporarily overloaded"; give it a few bounded attempts before judging.
for (let attempt = 1; attempt <= 4; attempt++) {
  await channels.start();
  console.log(`start attempt ${attempt}: mode=${channels.mode()} after ${Date.now() - t0} ms`);
  if (channels.mode() === 'relay') break;
  console.log('status:', JSON.stringify(channels.status()));
  if (attempt === 4) process.exit(1);
  await channels.close(); // drop the scheduled 60 s retry; the probe retries on its own cadence
  await Bun.sleep(15_000);
  channels = createChannels(cfg, PROBE_NAMES);
  channels.onWarning((w, via) => got.push(`warning:${w.eventId}:${via}:${w.testOnly ? 'testOnly' : 'canonical'}`));
  channels.onPantheon((n, via) => got.push(`pantheon:${n.eventId}:${via}:${n.testOnly ? 'testOnly' : 'canonical'}`));
}
const id = crypto.randomUUID().slice(0, 8);
await channels.warn({ eventId: `probe-warn-${id}`, roomId: 'probe', ghostId: 'probe-ghost', ghostName: 'Probe Ghost', hunterId: 'probe-hunter', hunterName: 'Probe Hunter', power: 'shiva', suggestedStrategy: 'ambush', at: Date.now(), testOnly: true });
await channels.share({ eventId: `probe-note-${id}`, roomId: 'probe', deity: 'shiva', hunterId: 'probe-hunter', hunterName: 'Probe Hunter', enemyId: 'probe-ghost', enemyLevel: 1, banished: false, at: Date.now(), testOnly: true });
const deadline = Date.now() + 12_000;
while (Date.now() < deadline && got.filter((g) => g.endsWith(':relay:testOnly')).length < 2) await Bun.sleep(100);
console.log(`deliveries after ${Date.now() - t0} ms:`, JSON.stringify(got));
console.log('status:', JSON.stringify(channels.status()));
await channels.close();
const viaRelay = got.filter((g) => g.includes(':relay:')).length;
const viaLocal = got.filter((g) => g.includes(':local:')).length;
console.log(viaRelay === 2 && viaLocal === 0 ? 'PASS real Relay delivered both testOnly messages to a distinct registered participant' : `FAIL relay=${viaRelay} localFallback=${viaLocal}`);
process.exit(viaRelay === 2 && viaLocal === 0 ? 0 : 1);
