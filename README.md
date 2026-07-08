# stock-cockpit-sentinel

Off-Railway, tamper-evidence sidecar for the **Stock Cockpit** paper-trading app. **No app code, no
positions, no keys** — only sha256 hashes, counts, timestamps, and two small workflow files.

## Why this repo exists

The app keeps a hash-chained **audit ledger** (every decision/order, each entry linked to the one
before it). That chain detects *edits* to past entries — but a chain that has had its **newest rows
deleted off the tail** still verifies clean. Someone with database access could quietly truncate the
recent history and nothing on the box would notice.

This repo closes that hole. A scheduled GitHub Actions workflow **pulls the ledger's current head**
from the app's public `/api/audit/anchor` endpoint every ~30 minutes and **commits the head hash into
git**. Git commit history on GitHub's infrastructure is:

- **off Railway** — wiping the app's Postgres cannot delete these commits;
- **append-only in practice** — the history is public and immutable-by-convention;
- **tamper-evident** — if the app's head later disagrees with the last anchor we committed, the app's
  `verify-anchor` check flags **TRUNCATION SUSPECTED**.

## Why the repo is PUBLIC

Public repos get **unlimited free Actions minutes**. A 5-minute cron alone (the dead-man in Hole 2)
would blow past the 2,000 min/month private-repo allowance. The only things stored here are hashes,
counts, and timestamps — publishing them leaks nothing an attacker can act on (no positions, no keys,
no entry contents). **Hashes only — deleting the app's Railway data cannot delete these commits.**

## What's in here

| Path | What it is |
|---|---|
| `.github/workflows/anchor.yml` | Every ~30 min: fetch `/api/audit/anchor`, commit the head into `anchors/`. Uses the automatic `GITHUB_TOKEN` — **zero new secret on Railway.** |
| `anchors/latest.json` | The most recent head `{ ok, count, headSeq, headHash, at, anchoredAt }`. |
| `anchors/YYYY-MM.ndjson` | One appended line per run — the month's anchor history. |

## Configuration

- **Repo variable `APP_URL`** — the app's base URL (e.g. `https://web-production-0b611.up.railway.app`).
  A *variable*, not a secret: the anchor endpoint is public.

## What this is NOT

This is a **tamper-evidence** layer, not a protective control. Broker-native bracket stops remain the
**primary** protective net for the app; the Railway watchdog is a paper-only secondary. The anchor only
makes on-box history-tampering *detectable* — it cannot prevent it.

> Hole 2 (the off-Railway dead-man switch) will add a second workflow to this same repo, shipped
> **DISARMED** (no live keys) until a documented go-live day.
