/**
 * scripts/token-report.ts — offline token/cost report from SDK transcripts.
 *
 * Usage:
 *   pnpm exec tsx scripts/token-report.ts                    # all groups, summary
 *   pnpm exec tsx scripts/token-report.ts --group sine       # one group, detailed
 *   pnpm exec tsx scripts/token-report.ts --by hour          # burst profile
 *   pnpm exec tsx scripts/token-report.ts --by session       # cost concentration
 *   pnpm exec tsx scripts/token-report.ts --json             # machine-readable
 *
 * Why this exists: the agent-runner now records per-turn totals into each
 * session's `outbound.db` (`session_usage`), but only from the turn the
 * provider is currently running — it says nothing about history, and its
 * per-model breakdown is a single JSON blob. The per-turn `message.usage`
 * written into each session's `.jsonl` transcript is still the only record
 * that reaches back before that plumbing landed and the only one that
 * separates a subagent's spend from its parent turn. This reads those
 * transcripts.
 *
 * Transcripts live at
 *   data/v2-sessions/<agent-group-id>/.claude-shared/projects/<slug>/
 *     <session-uuid>.jsonl                       — main thread
 *     <session-uuid>/subagents/agent-<id>.jsonl  — spawned subagents
 * The subagent split matters: subagents are invisible to every budget and
 * rate-limit mechanism in the system, and are typically the bulk of spend.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

/** USD per million tokens: [input, cache_write, cache_read, output]. */
const PRICING: Record<string, [number, number, number, number]> = {
  'claude-opus-5': [15, 18.75, 1.5, 75],
  'claude-opus-4-8': [15, 18.75, 1.5, 75],
  'claude-opus-4-1': [15, 18.75, 1.5, 75],
  'claude-sonnet-5': [3, 3.75, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 0.3, 15],
  'claude-haiku-4-5': [1, 1.25, 0.1, 5],
};

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface Turn {
  group: string;
  session: string;
  isSubagent: boolean;
  model: string;
  hour: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Input-side tokens — what a turn actually re-sends to the model. */
function inputSide(t: Turn): number {
  return t.input + t.cacheWrite + t.cacheRead;
}

function costUsd(t: Turn): number {
  const p = PRICING[t.model];
  if (!p) return 0;
  return (t.input * p[0] + t.cacheWrite * p[1] + t.cacheRead * p[2] + t.output * p[3]) / 1e6;
}

/** Walk a transcript directory, yielding every assistant turn that carries usage. */
function readTranscripts(projectsDir: string, group: string): Turn[] {
  const turns: Turn[] = [];
  const files: { file: string; session: string; isSubagent: boolean }[] = [];

  const walk = (dir: string, session: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // `<uuid>/subagents/` hangs off the parent session's own directory,
        // so the session label carries down from whichever level named it.
        walk(full, e.name === 'subagents' ? session : e.name);
      } else if (e.name.endsWith('.jsonl')) {
        // A main-thread file IS its session (`<uuid>.jsonl`); a subagent file
        // is named `agent-<id>.jsonl` and belongs to the `<uuid>` dir above it,
        // so that both roll up under the conversation that spawned them.
        const isSubagent = dir.endsWith(`${path.sep}subagents`);
        files.push({
          file: full,
          session: isSubagent ? session : path.basename(e.name, '.jsonl'),
          isSubagent,
        });
      }
    }
  };
  walk(projectsDir, '');

  for (const { file, session, isSubagent } of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o: { message?: { usage?: Usage; model?: string }; timestamp?: string };
      try {
        o = JSON.parse(line);
      } catch {
        continue; // partially-written last line on a live transcript
      }
      const u = o.message?.usage;
      if (!u) continue;
      turns.push({
        group,
        session,
        isSubagent,
        model: o.message?.model ?? 'unknown',
        hour: (o.timestamp ?? '').slice(0, 13),
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      });
    }
  }
  return turns;
}

/** Map agent-group id → folder name, so reports read in human terms. */
function groupFolders(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    // Read-only on purpose: a report must never migrate or mutate the central DB.
    const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
    try {
      const rows = db.prepare('SELECT id, folder FROM agent_groups').all() as {
        id: string;
        folder: string;
      }[];
      for (const r of rows) map.set(r.id, r.folder);
    } finally {
      db.close();
    }
  } catch {
    // DB unavailable (fresh checkout, wrong cwd) — fall back to raw ids.
  }
  return map;
}

function collect(groupFilter?: string): Turn[] {
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  const folders = groupFolders();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionsRoot);
  } catch {
    console.error(`No session data at ${sessionsRoot}`);
    process.exit(1);
  }

  const turns: Turn[] = [];
  for (const groupId of dirs) {
    const label = folders.get(groupId) ?? groupId;
    if (groupFilter && label !== groupFilter && groupId !== groupFilter) continue;
    const projects = path.join(sessionsRoot, groupId, '.claude-shared', 'projects');
    if (!fs.existsSync(projects)) continue;
    turns.push(...readTranscripts(projects, label));
  }
  return turns;
}

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const fmtUsd = (n: number) => `$${n.toFixed(0)}`;

interface Bucket {
  turns: number;
  inputSide: number;
  output: number;
  usd: number;
}

function bucket(turns: Turn[], key: (t: Turn) => string): Map<string, Bucket> {
  const m = new Map<string, Bucket>();
  for (const t of turns) {
    const k = key(t);
    const b = m.get(k) ?? { turns: 0, inputSide: 0, output: 0, usd: 0 };
    b.turns++;
    b.inputSide += inputSide(t);
    b.output += t.output;
    b.usd += costUsd(t);
    m.set(k, b);
  }
  return m;
}

function table(title: string, m: Map<string, Bucket>, limit = 15): void {
  const rows = [...m.entries()].sort((a, b) => b[1].usd - a[1].usd || b[1].inputSide - a[1].inputSide);
  console.log(`\n${title}`);
  console.log(
    'key'.padEnd(34) + 'turns'.padStart(8) + 'input'.padStart(10) + 'output'.padStart(9) + 'USD'.padStart(9),
  );
  for (const [k, b] of rows.slice(0, limit)) {
    console.log(
      k.slice(0, 33).padEnd(34) +
        String(b.turns).padStart(8) +
        fmtTok(b.inputSide).padStart(10) +
        fmtTok(b.output).padStart(9) +
        fmtUsd(b.usd).padStart(9),
    );
  }
  if (rows.length > limit) console.log(`… ${rows.length - limit} more`);
}

// --- main ---------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const groupFilter = arg('--group');
const by = arg('--by');
const asJson = argv.includes('--json');

const turns = collect(groupFilter);
if (turns.length === 0) {
  console.error(groupFilter ? `No transcripts for group "${groupFilter}".` : 'No transcripts found.');
  process.exit(1);
}

const totalUsd = turns.reduce((s, t) => s + costUsd(t), 0);
const totalIn = turns.reduce((s, t) => s + inputSide(t), 0);
const totalOut = turns.reduce((s, t) => s + t.output, 0);
const subUsd = turns.filter((t) => t.isSubagent).reduce((s, t) => s + costUsd(t), 0);
const hours = [...new Set(turns.map((t) => t.hour).filter(Boolean))];

if (asJson) {
  console.log(
    JSON.stringify(
      {
        turns: turns.length,
        inputTokens: totalIn,
        outputTokens: totalOut,
        usd: Number(totalUsd.toFixed(2)),
        subagentUsd: Number(subUsd.toFixed(2)),
        activeHours: hours.length,
        byGroup: Object.fromEntries(bucket(turns, (t) => t.group)),
        byModel: Object.fromEntries(bucket(turns, (t) => t.model)),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`\nTranscript token report${groupFilter ? ` — group "${groupFilter}"` : ''}`);
console.log(`${turns.length.toLocaleString()} API calls · ${fmtTok(totalIn)} input · ${fmtTok(totalOut)} output · ~${fmtUsd(totalUsd)} (list prices)`);
console.log(`Subagents: ${fmtUsd(subUsd)} = ${Math.round((100 * subUsd) / (totalUsd || 1))}% of spend`);
console.log(`Active hours: ${hours.length}`);

if (by === 'hour') {
  const m = bucket(turns, (t) => t.hour || 'unknown');
  const top5 = [...m.values()].sort((a, b) => b.inputSide - a.inputSide).slice(0, 5);
  const burst = top5.reduce((s, b) => s + b.inputSide, 0);
  console.log(`Top-5 hours = ${Math.round((100 * burst) / (totalIn || 1))}% of all input tokens`);
  table('By hour (UTC)', m, 12);
} else if (by === 'session') {
  table('By session (main thread + its subagents)', bucket(turns, (t) => t.session));
} else if (by === 'model') {
  table('By model', bucket(turns, (t) => `${t.model} ${t.isSubagent ? '(subagent)' : '(main)'}`));
} else {
  table('By group', bucket(turns, (t) => t.group));
  table('By model and tier', bucket(turns, (t) => `${t.model} ${t.isSubagent ? '(subagent)' : '(main)'}`), 10);
}
console.log();
