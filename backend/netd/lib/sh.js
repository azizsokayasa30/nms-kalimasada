'use strict';

const { execFile } = require('node:child_process');

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: options.timeout ?? 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '').trim() || (error && !stderr ? String(error.message) : ''),
        });
      },
    );
  });
}

async function must(cmd, args, options) {
  const result = await run(cmd, args, options);
  if (!result.ok) throw new Error(result.stderr || `${cmd} gagal`);
  return result.stdout;
}

async function json(cmd, args) {
  const out = await must(cmd, args);
  return out.trim() ? JSON.parse(out) : [];
}

async function unitActive(unit) {
  const result = await run('systemctl', ['is-active', unit]);
  return result.stdout.trim() === 'active';
}

async function unitLog(units, lines = 30) {
  const args = ['-n', String(lines), '-o', 'cat', '--no-pager'];
  for (const unit of units) args.push('-u', unit);
  const result = await run('journalctl', args);
  const rows = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/\.service:|^(Started|Starting|Stopped|Stopping|Failed to start|Deactivated|Exiting due to fatal error)\b/.test(line));
  const bad = [...rows].reverse().find((line) => /error|fail|denied|refused|timeout|timed out|unreachable|cannot|AUTH|TLS|resolve|no response|retry/i.test(line));
  const line = bad ?? rows[rows.length - 1] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

module.exports = { run, must, json, unitActive, unitLog };
