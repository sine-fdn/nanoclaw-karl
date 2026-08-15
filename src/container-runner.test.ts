import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { caBundleEnvArgs, hardeningArgs, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('caBundleEnvArgs', () => {
  const withBundle = ['-e', 'HOME=/home/node', '-e', 'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem'];

  it('mirrors the SDK-pushed bundle onto the clients that ignore SSL_CERT_FILE', () => {
    expect(caBundleEnvArgs(withBundle)).toEqual([
      '-e',
      'REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem',
      '-e',
      'CURL_CA_BUNDLE=/tmp/onecli-combined-ca.pem',
      '-e',
      'GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem',
    ]);
  });

  it('follows the SDK if it moves the bundle rather than assuming /tmp', () => {
    expect(caBundleEnvArgs(['-e', 'SSL_CERT_FILE=/etc/onecli/ca.pem'])).toEqual([
      '-e',
      'REQUESTS_CA_BUNDLE=/etc/onecli/ca.pem',
      '-e',
      'CURL_CA_BUNDLE=/etc/onecli/ca.pem',
      '-e',
      'GIT_SSL_CAINFO=/etc/onecli/ca.pem',
    ]);
  });

  // The SDK skips the bundle when it can't build one. Emitting a path anyway
  // would point every requests/git call at a file that isn't mounted, turning
  // a proxy-only failure into a total TLS failure.
  it('emits nothing when no bundle was mounted', () => {
    expect(caBundleEnvArgs(['-e', 'HOME=/home/node', '-e', 'DENO_CERT=/tmp/x.pem'])).toEqual([]);
    expect(caBundleEnvArgs([])).toEqual([]);
  });

  it('does not match a variable that merely ends in SSL_CERT_FILE', () => {
    expect(caBundleEnvArgs(['-e', 'MY_SSL_CERT_FILE=/tmp/other.pem'])).toEqual([]);
  });
});

describe('CA env fill runs after the gateway apply (structural)', () => {
  // caBundleEnvArgs reads SSL_CERT_FILE out of the args, and only
  // applyContainerConfig puts it there. Called earlier it would silently
  // return [] and every Python `requests` call would keep failing TLS.
  it('calls caBundleEnvArgs after onecli.applyContainerConfig', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    const caFill = src.indexOf('args.push(...caBundleEnvArgs(args))');
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(caFill).toBeGreaterThan(gatewayApply);
  });
});

describe('persistent HOME cache mount (structural)', () => {
  // Containers run with --rm, so Marker's multi-GB surya weights and its font
  // re-download on every spawn unless HOME's cache is mounted from the host.
  // Driving buildMounts needs a provider registry + composed group surfaces,
  // so guard the wiring structurally: the mount must exist, be writable, and
  // not sit behind the defaultSurfaces (Claude-provider) gate.
  it('mounts the per-group model cache at /home/node/.cache read-write', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const idx = src.indexOf('modelCacheDir(agentGroup.id)');
    expect(idx).toBeGreaterThan(-1);
    const mountExpr = src.slice(idx, idx + 160);
    expect(mountExpr).toContain("containerPath: '/home/node/.cache'");
    expect(mountExpr).toContain('readonly: false');
  });

  it('creates the host directory unconditionally, not behind defaultSurfaces', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'group-init.ts'), 'utf-8');
    const claudeGate = src.indexOf('if (defaultSurfaces) {');
    const cacheInit = src.indexOf('const cacheDir = modelCacheDir(group.id)');
    expect(cacheInit).toBeGreaterThan(-1);
    // The cache step lives after the defaultSurfaces block closes, so a
    // non-Claude provider still gets a cache.
    expect(cacheInit).toBeGreaterThan(claudeGate);
    expect(src.slice(cacheInit)).not.toContain('defaultSurfaces');
  });
});

describe('plugins read-only mount (structural)', () => {
  // Stamped plugin content must be immutable inside the container (Agent
  // Plugins contract: writes go to plugin-data/). Driving buildMounts needs a
  // provider registry + composed group surfaces, so guard the wiring
  // structurally: the plugins dir must be mounted at CONTAINER_PLUGINS_DIR
  // with readonly: true.
  it('mounts groups/<folder>/plugins read-only', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const idx = src.indexOf("path.join(groupDir, 'plugins')");
    expect(idx).toBeGreaterThan(-1);
    const mountExpr = src.slice(idx, idx + 200);
    expect(mountExpr).toContain('CONTAINER_PLUGINS_DIR');
    expect(mountExpr).toContain('readonly: true');
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain(
      "CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || ''",
    );
    expect(cfg).toContain(
      "CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || ''",
    );
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('syncSkillSymlinks blocked-entry warning (structural)', () => {
  // Real directories in .claude-shared/skills/ block the managed symlinks:
  // the prune loop only removes symlinks and the create loop skips any
  // existing entry. Template overlays depend on surviving that (see
  // src/group-skills.ts); stale pre-refactor skill copies (#3001) get served
  // forever with no trace. Driving syncSkillSymlinks needs a real group
  // filesystem, and importing more of the module pulls the provider side
  // effects, so guard the wiring structurally: the create loop must warn
  // when a non-symlink entry occupies a desired skill path.
  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const createLoop = src.indexOf('// Create symlinks for desired skills');
    expect(createLoop).toBeGreaterThan(-1);
    const tail = src.slice(createLoop);
    expect(tail).toMatch(/else if \(!entry\.isSymbolicLink\(\)\)/);
    expect(tail).toMatch(/log\.warn\(\s*'Shared skill not symlinked/);
  });
});

describe('hardeningArgs', () => {
  it('always emits the three unconditional flags', () => {
    const args = hardeningArgs('2048');
    expect(args).toContain('--cap-drop=ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--init');
  });

  it('emits the pids limit when positive', () => {
    expect(hardeningArgs('2048').join(' ')).toContain('--pids-limit 2048');
  });

  // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
  it('omits the pids limit for 0, negatives, blank and garbage', () => {
    for (const v of ['0', '-1', '', '   ', 'lots']) {
      expect(hardeningArgs(v).join(' ')).not.toContain('--pids-limit');
    }
  });

  it('floors fractional values', () => {
    expect(hardeningArgs('2048.7').join(' ')).toContain('--pids-limit 2048');
  });
});
