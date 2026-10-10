'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SOURCE_MAX = 64 * 1024;
const CASE_MAX = 20;
const TEXT_MAX = 64 * 1024;
const TOTAL_MAX = 512 * 1024;
const OUTPUT_MAX = 64 * 1024;
const COMPILE_MS = 10_000;
const RUN_MS = 2_000;
const COMPILE_AS = 512 * 1024 * 1024;
const RUN_AS = 256 * 1024 * 1024;

let busy = false;

function validateRun(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid request';
  if (typeof body.source !== 'string' || body.source.length === 0) return 'Source is empty';
  if (body.source.length > SOURCE_MAX) return 'Source is larger than 64 KB';
  if (body.source.includes('\0')) return 'Source contains a null byte';
  if (body.mode === 'program') {
    if (body.cases !== undefined) return 'A program run does not take cases';
    return null;
  }
  if (body.mode !== undefined && body.mode !== 'tests') return 'Invalid run mode';
  if (!Array.isArray(body.cases)) return 'Cases must be a list';
  if (body.cases.length > CASE_MAX) return 'At most 20 cases';
  let total = Buffer.byteLength(body.source);
  for (const item of body.cases) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Invalid case';
    if (typeof item.input !== 'string' || typeof item.expected !== 'string') {
      return 'Each case needs input and expected text';
    }
    if (item.input.includes('\0') || item.expected.includes('\0')) return 'Case text contains a null byte';
    if (item.input.length > TEXT_MAX || item.expected.length > TEXT_MAX) return 'Case text is larger than 64 KB';
    total += Buffer.byteLength(item.input) + Buffer.byteLength(item.expected);
    if (total > TOTAL_MAX) return 'Run is larger than 512 KB';
  }
  return null;
}

function normalizeOutput(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/g, '');
}

function sandboxArgs(binds, command) {
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--uid',
    '0',
    '--gid',
    '0',
    '--hostname',
    'sandbox',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...binds,
    '--chdir',
    '/work',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    ...command,
  ];
}

function limited(addressBytes, wallMs, command) {
  const seconds = Math.max(1, Math.ceil(wallMs / 1000));
  return [
    'prlimit',
    `--as=${addressBytes}`,
    `--data=${addressBytes}`,
    '--fsize=1048576',
    '--nproc=32',
    '--nofile=64',
    `--cpu=${seconds + 1}`,
    '--',
    'timeout',
    '-k',
    '1s',
    `${seconds}s`,
    ...command,
  ];
}

function capture(child, maxOutput) {
  let stdout = '';
  let stderr = '';
  let truncated = false;

  function take(chunk, target) {
    const text = chunk.toString('utf8');
    if (target === 'stdout') {
      const room = maxOutput - stdout.length;
      if (room > 0) stdout += text.slice(0, room);
      if (text.length > room) truncated = true;
    } else {
      const room = maxOutput - stderr.length;
      if (room > 0) stderr += text.slice(0, room);
      if (text.length > room) truncated = true;
    }
    if (truncated) child.kill('SIGKILL');
  }

  child.stdout.on('data', (chunk) => take(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => take(chunk, 'stderr'));
  return {
    truncated: () => truncated,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function spawnSandbox({ args, stdin, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bwrap', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const started = Date.now();
    const output = capture(child, OUTPUT_MAX);
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs + 1500);

    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: output.stdout(),
        stderr: output.stderr(),
        truncated: output.truncated(),
        timeMs: Date.now() - started,
      });
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function classify(result) {
  if (result.truncated) return 'output_limit';
  if (result.signal === 'SIGKILL' || result.signal === 'SIGXCPU' || result.code === 124 || result.code === 137) {
    return 'timeout';
  }
  if (result.code !== 0) return 'runtime';
  return null;
}

async function compileAndRun(source, cases) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-run-'));
  try {
    await fs.writeFile(path.join(dir, 'main.cpp'), source, { mode: 0o600 });
    const compile = await spawnSandbox({
      timeoutMs: COMPILE_MS,
      args: sandboxArgs(
        ['--ro-bind', '/bin', '/bin', '--bind', dir, '/work'],
        limited(COMPILE_AS, COMPILE_MS, [
          'g++',
          '-std=c++17',
          '-O2',
          '-pipe',
          '-Wall',
          '-Wextra',
          '-o',
          '/work/main',
          '/work/main.cpp',
        ]),
      ),
    });
    const compileProblem = classify(compile);
    if (compileProblem || compile.code !== 0) {
      const detail =
        compileProblem === 'timeout'
          ? 'Compile timed out'
          : compileProblem === 'output_limit'
            ? 'Compiler output was too large'
            : compile.stderr.trim() || 'Compilation failed';
      return {
        status: 'compile_error',
        compile: { ok: false, stderr: detail.slice(0, OUTPUT_MAX) },
        program: null,
        cases: (cases ?? []).map(() => ({ status: 'idle', actual: '', timeMs: 0, reason: null })),
      };
    }

    const binary = path.join(dir, 'main');
    if (cases === null) {
      const result = await spawnSandbox({
        timeoutMs: RUN_MS,
        stdin: '',
        args: sandboxArgs(
          ['--ro-bind', binary, '/work/main'],
          limited(RUN_AS, RUN_MS, ['/work/main']),
        ),
      });
      return {
        status: 'ran',
        compile: { ok: true, stderr: compile.stderr.trim().slice(0, OUTPUT_MAX) },
        program: {
          stdout: result.stdout.slice(0, OUTPUT_MAX),
          stderr: result.stderr.slice(0, OUTPUT_MAX),
          timeMs: result.timeMs,
          reason: classify(result),
          exitCode: result.code,
        },
        cases: [],
      };
    }
    const ran = [];
    for (const item of cases) {
      const result = await spawnSandbox({
        timeoutMs: RUN_MS,
        stdin: item.input,
        args: sandboxArgs(
          ['--ro-bind', binary, '/work/main'],
          limited(RUN_AS, RUN_MS, ['/work/main']),
        ),
      });
      const reason = classify(result);
      const actual = result.stdout.slice(0, OUTPUT_MAX);
      const passed = reason === null && normalizeOutput(actual) === normalizeOutput(item.expected);
      ran.push({
        status: passed ? 'pass' : 'fail',
        actual,
        stderr: result.stderr.slice(0, OUTPUT_MAX),
        timeMs: result.timeMs,
        reason,
        exitCode: result.code,
      });
    }
    return {
      status: 'ran',
      compile: { ok: true, stderr: compile.stderr.trim().slice(0, OUTPUT_MAX) },
      cases: ran,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function executeRun(body) {
  if (busy) {
    const error = new Error('busy');
    error.code = 'BUSY';
    throw error;
  }
  busy = true;
  try {
    const mode = body.mode === 'program' ? 'program' : 'tests';
    return await compileAndRun(body.source, mode === 'program' ? null : body.cases);
  } finally {
    busy = false;
  }
}

module.exports = {
  validateRun,
  executeRun,
  SOURCE_MAX,
  CASE_MAX,
  TEXT_MAX,
  TOTAL_MAX,
};
