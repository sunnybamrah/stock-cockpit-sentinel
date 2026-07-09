// OFF-RAILWAY DEAD-MAN SWITCH — HOLE 2. Self-contained, DISARMED by default.
//
// WHAT IT IS: a LAST-RESORT net for the case where Railway itself is gone — the app AND the on-Railway
// watchdog can die together (Railway has no SLA). This file runs OFF Railway (on GitHub Actions, in the
// public `stock-cockpit-sentinel` repo) on its OWN schedule with its OWN copy of the live Alpaca keys.
// Every ~5 min it probes the app's public /healthz. If the app is dark for TWO consecutive runs AND the
// dead-man is ARMED AND its live keys are present, it flattens the LIVE Alpaca account directly
// (sell-only: DELETE /v2/positions?cancel_orders=true — the same sanctioned pattern the on-Railway
// watchdog uses; it can NEVER buy) and alerts the owner's phone.
//
// SHIPPED DISARMED: today there are NO live keys anywhere (Railway, GitHub, local) and `DEADMAN_ARMED`
// is unset, so the flatten path is DEAD CODE until a documented go-live day (see RUNBOOK-DEADMAN.md).
// Until armed, broker-native bracket stops are the PRIMARY protective net; the Railway `watchdog/`
// service is a paper-only SECONDARY; this off-Railway dead-man is the TERTIARY net for a total-Railway
// outage. It is a net, not a stop-loss.
//
// FAIL-SAFE DIRECTION: on ANY bad/garbage input the decision is NO-FIRE. Because bracket stops are the
// primary net, "don't fire" is the safe failure direction — a false flatten (selling everything on a
// transient blip) is worse than a missed one, so every ambiguous case declines to act.
//
// LOG DISCIPLINE (public workflow logs): this file prints ONLY status words + counts + HTTP status
// codes. It NEVER echoes secrets, response bodies, symbols, quantities, or dollar amounts. GitHub masks
// registered secrets, but we never print them regardless.
//
// SELF-CONTAINED: imports ONLY node builtins — never any app code (broker/engine/server/db). A copy of
// this exact file lives at the sentinel repo root; `offsite/sentinel/deadman.mjs` in this repo is the
// byte-identical mirror (drift-guarded by test/deadman-offsite.test.mjs). Source of truth = this file.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const log = (s) => console.log(new Date().toISOString(), '[deadman]', s);

// ── PURE DECISION (exported, unit-tested; no I/O, no clock, no network) ────────────────────────────
// Decide what one run should do, given this run's probe result + the cross-run streak + arm/keys state.
// Fires ONLY when: every probe in this run failed (app fully dark) AND this makes 2 consecutive dark
// runs (streak+1 >= 2) AND the dead-man is ARMED AND its live keys are present. Any garbage input ⇒
// noop (fail-safe: never fire on bad data). A dryRun over a dark app reports what a real run WOULD do
// without sending an order; a dryRun over a LIVE (responding) app is still just 'noop/alive'.
export function decideOffsite({ probesFailed, probesTotal, streak, armed, keysPresent, dryRun } = {}) {
  const pf = Number(probesFailed);
  const pt = Number(probesTotal);
  const st = Number(streak);
  if (!Number.isFinite(pf) || !Number.isFinite(pt) || !Number.isFinite(st) || pt <= 0 || pf < 0 || st < 0) {
    return { action: 'noop', reason: 'bad input — failing safe (no fire)' };
  }
  const allFailed = pf === pt; // every probe this run failed ⇒ app fully dark
  if (!allFailed) {
    // App responded to at least one probe — it is alive. (Checked BEFORE dryRun so a dry-run against a
    // healthy app reads "noop/alive", matching the runbook's go-live smoke test.)
    return { action: 'noop', reason: 'app responded to a probe — alive (' + pf + '/' + pt + ' failed)' };
  }
  if (dryRun) {
    const wouldFire = armed === true && keysPresent === true;
    return {
      action: 'dry-run',
      reason: wouldFire
        ? 'DRY RUN — app is dark; ARMED + live keys present, so a real run would FLATTEN the LIVE account'
        : 'DRY RUN — app is dark but ' + (armed !== true ? 'DISARMED' : 'no live keys') + ', so a real run would STAND DOWN',
    };
  }
  const confirmed = st + 1; // this run makes it `confirmed` consecutive dark runs
  if (confirmed < 2) {
    return { action: 'noop', reason: 'first dark run (' + confirmed + '/2) — waiting for a second run to confirm before acting' };
  }
  if (armed !== true) {
    return { action: 'stand-down', reason: 'app dark ' + confirmed + ' runs but DISARMED — standing down (bracket stops are the primary net)' };
  }
  if (keysPresent !== true) {
    return { action: 'stand-down', reason: 'app dark ' + confirmed + ' runs + armed, but NO live keys present — standing down (cannot flatten)' };
  }
  return { action: 'flatten', reason: 'app dark ' + confirmed + ' consecutive runs + ARMED + live keys present — flattening the LIVE account' };
}

// ── Plain-English alerts (exported for tests) ──────────────────────────────────────────────────────
// The 'fired' copy names the LIVE account honestly (test-asserted). Broker brackets are named as the
// primary net so an alert can never imply this is the main protection.
export function buildAlert(kind, d = {}) {
  switch (kind) {
    case 'fired':
      return '🚨 Stock Cockpit OFF-RAILWAY DEAD-MAN FIRED — the app was dark for ' + (d.confirmed || 2)
        + ' consecutive checks; flattened the LIVE account to cash + cancelled orders directly at Alpaca. '
        + 'Result: HTTP ' + (d.result ? d.result.status : '?') + ', positions=' + (d.result && d.result.count != null ? d.result.count : '?')
        + '. (Broker bracket stops are the primary net; this fired as the last-resort off-infrastructure net.)';
    case 'dry-run':
      return '🧪 Stock Cockpit OFF-RAILWAY DEAD-MAN DRY-RUN — no order was sent. ' + (d.reason || '');
    case 'stand-down':
      return '⚠️ Stock Cockpit OFF-RAILWAY DEAD-MAN — the app looks dark (' + (d.confirmed || 2)
        + ' consecutive checks) but the dead-man is DISARMED, so it stood down (no LIVE flatten). '
        + 'Broker bracket stops remain the primary net.';
    case 'recovery':
      return '✅ Stock Cockpit OFF-RAILWAY DEAD-MAN — the app is BACK UP; the outage streak and fire latch were reset.';
    default:
      return 'Stock Cockpit off-Railway dead-man: ' + String(kind);
  }
}

// ── Cross-run state (streak + fire latch), persisted to deadman-state.json ─────────────────────────
// `streak` = consecutive dark runs; `fired` = one terminal action per outage (flatten OR stand-down),
// so we never repeat the flatten or spam alerts every 5 min. A probe success resets both. Reads/writes
// fail SAFE: unreadable/garbage state ⇒ a fresh { streak:0, fired:false } (never a stuck "fired").
export function normalizeState(s) {
  const n = Number(s && s.streak);
  const streak = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return { streak, fired: !!(s && s.fired === true) };
}
export function readState(file) {
  try { return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return { streak: 0, fired: false }; }
}
export function writeState(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(normalizeState(state)) + '\n'); return true; }
  catch (e) { log('state write failed: ' + e.message); return false; }
}

// ── Probe: is the app alive? GET /healthz, 10s timeout. Any error/timeout ⇒ dark (false). ──────────
export async function probe(appUrl, fetchImpl = fetch, timeoutMs = 10000) {
  const base = String(appUrl || '').replace(/\/$/, '');
  if (!base) return false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetchImpl(base + '/healthz', { signal: c.signal });
    clearTimeout(t);
    return !!(r && r.ok);
  } catch { return false; }
}

// ── Flatten the LIVE account (sell-only). This is the ONLY place the live Alpaca REST host appears. ──
// Keys are read from env at call time; logs ONLY the HTTP status + a position count (never keys, never
// symbols/qty/dollars). Callers reach here ONLY after decideOffsite returns 'flatten' (armed + keys +
// 2 dark runs), so a disarmed or keyless run makes ZERO network calls to the live host.
export async function flattenLive(fetchImpl = fetch) {
  const url = 'https://api.alpaca.markets/v2/positions?cancel_orders=true';
  const r = await fetchImpl(url, {
    method: 'DELETE',
    headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_LIVE_KEY_ID || '',
      'APCA-API-SECRET-KEY': process.env.ALPACA_LIVE_SECRET_KEY || '',
    },
  });
  let count = null;
  try { const body = await r.json(); if (Array.isArray(body)) count = body.length; } catch { /* body not JSON — count stays unknown */ }
  log('FLATTEN LIVE -> HTTP ' + r.status + ' positions=' + (count == null ? '?' : count));
  return { status: r.status, count };
}

// ── Alert hop (optional). POST plain text to DEADMAN_ALERT_URL (ntfy topic). Swallows errors; always
// called AFTER any flatten so it can never block the protective action. ─────────────────────────────
export async function sendAlert(msg, fetchImpl = fetch) {
  const url = process.env.DEADMAN_ALERT_URL;
  if (!url) { log('no DEADMAN_ALERT_URL set — alert skipped'); return false; }
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: msg, signal: c.signal });
    clearTimeout(t);
    log('alert sent');
    return true;
  } catch (e) { log('alert failed (swallowed): ' + e.message); return false; }
}

// ── ONE run (a single cron tick): probe N times, decide, act, persist state, alert. ────────────────
// Deps are injectable so tests drive it with mocks (zero real network). Defaults come from env so the
// GitHub Actions step just runs `node deadman.mjs`.
export async function runOnce(opts = {}) {
  const {
    appUrl = process.env.APP_URL || 'https://web-production-0b611.up.railway.app',
    fetchImpl = fetch,
    stateFile = new URL('deadman-state.json', import.meta.url).pathname,
    probesCount = clampInt(process.env.DEADMAN_PROBES, 3, 1, 10),
    probeIntervalMs = clampInt(process.env.DEADMAN_PROBE_INTERVAL_MS, 60000, 0, 600000),
    probeTimeoutMs = 10000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    armed = process.env.DEADMAN_ARMED === 'true',
    keysPresent = !!(process.env.ALPACA_LIVE_KEY_ID && process.env.ALPACA_LIVE_SECRET_KEY),
    dryRun = process.env.DRY_RUN === 'true',
  } = opts;

  const state = readState(stateFile);

  // Probe up to probesCount times, `probeIntervalMs` apart; ONE success ⇒ alive (short-circuit).
  let failed = 0, alive = false;
  for (let i = 0; i < probesCount; i++) {
    if (await probe(appUrl, fetchImpl, probeTimeoutMs)) { alive = true; break; }
    failed++;
    if (i < probesCount - 1) await sleep(probeIntervalMs);
  }

  if (alive) {
    // Recovery: if we had a streak or had fired, announce the app is back and reset both.
    if (state.fired || state.streak > 0) {
      await sendAlert(buildAlert('recovery'), fetchImpl);
      writeState(stateFile, { streak: 0, fired: false });
      return { action: 'recovery', reason: 'app back UP — streak + fire latch reset' };
    }
    return { action: 'noop', reason: 'app alive' };
  }

  // Fully dark this run.
  const confirmed = state.streak + 1;
  // Already acted for this outage (flatten OR stand-down latched) — advance the streak, do NOT repeat.
  if (state.fired) {
    writeState(stateFile, { streak: confirmed, fired: true });
    return { action: 'noop', reason: 'already acted this outage (fire latch set) — not repeating' };
  }

  const decision = decideOffsite({ probesFailed: failed, probesTotal: probesCount, streak: state.streak, armed, keysPresent, dryRun });

  if (decision.action === 'flatten') {
    let result = { status: 0, count: null };
    try { result = await flattenLive(fetchImpl); }
    catch (e) { log('flatten error: ' + e.message); result = { status: -1, count: null, error: e.message }; }
    await sendAlert(buildAlert('fired', { confirmed, result }), fetchImpl);
    writeState(stateFile, { streak: confirmed, fired: true }); // latch: one flatten per outage
    return { action: 'flatten', reason: decision.reason, result };
  }
  if (decision.action === 'dry-run') {
    await sendAlert(buildAlert('dry-run', { reason: decision.reason }), fetchImpl);
    writeState(stateFile, { streak: confirmed, fired: false }); // a simulation never latches
    return { action: 'dry-run', reason: decision.reason };
  }
  if (decision.action === 'stand-down') {
    await sendAlert(buildAlert('stand-down', { confirmed }), fetchImpl);
    writeState(stateFile, { streak: confirmed, fired: true }); // latch so a disarmed+dark app alerts ONCE, not every 5 min
    return { action: 'stand-down', reason: decision.reason };
  }
  // noop — first dark run (streak 1/2); record it and wait for confirmation.
  writeState(stateFile, { streak: confirmed, fired: false });
  return { action: 'noop', reason: decision.reason };
}

function clampInt(v, dflt, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// Run only when executed directly (node deadman.mjs). When imported by a test, NOTHING runs — the
// module just exports the pure pieces above (no probe, no fetch, no state write).
const isEntry = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntry) {
  runOnce()
    .then((r) => { log('run complete -> ' + r.action + ' :: ' + r.reason); })
    .catch((e) => { log('run error: ' + e.message); process.exitCode = 1; });
}
