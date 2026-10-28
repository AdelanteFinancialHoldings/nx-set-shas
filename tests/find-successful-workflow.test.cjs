const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const TypeScript = require('typescript');

const repositoryRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repositoryRoot, 'find-successful-workflow.ts');
const bundlePath = path.join(repositoryRoot, 'dist', 'index.js');
const implementations = [
  ['TypeScript source', () => fs.readFileSync(sourcePath, 'utf8'), 'source'],
  ['checked-in action bundle', () => makeBundleTestSource(), 'bundle'],
];

let fixture;

test.before(() => {
  fixture = createGitFixture();
});

test.after(() => {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
});

for (const [
  implementationName,
  getCode,
  implementationKind,
] of implementations) {
  test(`${implementationName}: accepts an ancestor older than 100 commits`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
    });

    assert.equal(result.outputs.base, fixture.baselineSha);
    assert.equal(result.outputs.head, fixture.headSha);
    assert.equal(result.failure, undefined);
    assert.equal(
      JSON.stringify(result.workflowRunParams),
      JSON.stringify({
        owner: 'example',
        repo: 'repo',
        branch: 'main',
        workflow_id: '123',
        event: 'workflow_dispatch',
        status: 'success',
      }),
    );
    assert.ok(
      fixture.recentCommits.length === 100 &&
        !fixture.recentCommits.includes(fixture.baselineSha),
      'fixture must keep the baseline outside the latest 100 commits',
    );
  });

  test(`${implementationName}: accepts a recent ancestor`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.recentAncestorSha],
    });

    assert.equal(result.outputs.base, fixture.recentAncestorSha);
    assert.equal(result.outputs.head, fixture.headSha);
    assert.equal(result.failure, undefined);
  });

  test(`${implementationName}: rejects a commit outside the target branch`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.unrelatedSha],
    });

    assert.equal(result.failure?.includes('successful workflow run'), true);
    assert.equal(result.outputs.base, undefined);
  });

  test(`${implementationName}: checks older candidates after a non-ancestor`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.unrelatedSha, fixture.baselineSha],
    });

    assert.equal(result.outputs.base, fixture.baselineSha);
    assert.equal(result.failure, undefined);
  });

  test(`${implementationName}: retains the first eligible candidate in API order`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.recentAncestorSha, fixture.baselineSha],
    });

    assert.equal(result.outputs.base, fixture.recentAncestorSha);
    assert.equal(result.failure, undefined);
  });

  test(`${implementationName}: skips missing objects and checks older candidates`, async () => {
    const missingSha = '0'.repeat(40);
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [missingSha, fixture.baselineSha],
    });

    assert.equal(result.outputs.base, fixture.baselineSha);
    assert.match(result.stdout, new RegExp(missingSha));
    assert.match(result.stdout, /missing from local Git objects/i);
    assert.equal(result.failure, undefined);
  });

  test(`${implementationName}: validates ancestry against origin branch, not HEAD`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.headSha],
      targetSha: fixture.baselineSha,
    });

    assert.equal(result.failure?.includes('successful workflow run'), true);
    assert.equal(result.outputs.base, undefined);
  });

  test(`${implementationName}: fails on a missing target ref without falling back`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
      targetRefMissing: true,
      fatal: false,
    });

    assert.match(result.failure ?? '', /target|origin\/main|Git/i);
    assert.equal(result.outputs.base, undefined);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });

  test(`${implementationName}: fails on shallow history without falling back`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
      shallow: true,
      fatal: false,
    });

    assert.match(result.failure ?? '', /shallow|complete history/i);
    assert.equal(result.outputs.base, undefined);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });

  test(`${implementationName}: reports Git subprocess failures`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
      gitFailure: 'spawn',
      fatal: false,
    });

    assert.match(result.failure ?? '', /Git|spawn|validation/i);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });

  test(`${implementationName}: reports Git signal termination`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
      gitFailure: 'signal',
      fatal: false,
    });

    assert.match(result.failure ?? '', /SIGTERM/);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });

  test(`${implementationName}: reports unexpected ancestry status`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
      gitFailure: 'unexpected-status',
      fatal: false,
    });

    assert.match(result.failure ?? '', /exit status 128/);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });

  test(`${implementationName}: rejects malformed object-check output`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [fixture.baselineSha],
      gitFailure: 'malformed-object-response',
      fatal: false,
    });

    assert.match(result.failure ?? '', /invalid object check/);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });

  test(`${implementationName}: preserves no-success fatal behavior`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [],
      fatal: true,
    });

    assert.match(
      result.failure ?? '',
      /Unable to find a successful workflow run/,
    );
    assert.equal(result.outputs.base, undefined);
  });

  test(`${implementationName}: preserves configured no-baseline fallback`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [],
      fatal: false,
    });

    assert.equal(
      result.outputs.base,
      runGit(fixture.directory, ['rev-parse', 'refs/remotes/origin/main~1']),
    );
    assert.equal(result.outputs.noPreviousBuild, 'true');
    assert.equal(result.outputs.head, fixture.headSha);
    assert.equal(result.failure, undefined);
  });

  test(`${implementationName}: fails on a corrupt candidate object without falling back`, async () => {
    const directory = createCorruptCandidateFixture();
    try {
      const result = await runAction({
        getCode,
        implementationKind,
        candidates: [directory.corruptSha],
        directory: directory.path,
        fatal: false,
      });

      assert.match(result.failure ?? '', /Git failed to check candidate/);
      assert.match(result.failure ?? '', /inflate|unable to unpack|corrupt/i);
      assert.equal(result.outputs.base, undefined);
      assert.equal(result.outputs.head, undefined);
      assert.equal(result.outputs.noPreviousBuild, undefined);
    } finally {
      fs.rmSync(directory.path, { recursive: true, force: true });
    }
  });

  test(`${implementationName}: fails when the fallback commit count fails`, async () => {
    const result = await runAction({
      getCode,
      implementationKind,
      candidates: [],
      gitFailure: 'rev-list-count',
      fatal: false,
    });

    assert.match(result.failure ?? '', /Git failed to count commits/);
    assert.equal(result.outputs.base, undefined);
    assert.equal(result.outputs.head, undefined);
    assert.equal(result.outputs.noPreviousBuild, undefined);
  });
}

function createCorruptCandidateFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nx-set-shas-corrupt-'),
  );
  fs.cpSync(fixture.directory, directory, { recursive: true });
  const tree = runGit(directory, ['rev-parse', `${fixture.headSha}^{tree}`]);
  const corruptSha = runGit(directory, [
    'commit-tree',
    tree,
    '-p',
    fixture.headSha,
    '-m',
    'corrupt candidate',
  ]);
  const objectPath = path.join(
    directory,
    '.git',
    'objects',
    corruptSha.slice(0, 2),
    corruptSha.slice(2),
  );
  fs.chmodSync(objectPath, 0o644);
  fs.writeFileSync(objectPath, 'this is not a zlib stream');
  fs.chmodSync(objectPath, 0o444);
  return { path: directory, corruptSha };
}

function createGitFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nx-set-shas-history-'),
  );
  runGit(directory, ['init', '--quiet']);

  const stream = [];
  appendData(stream, 'blob\nmark :1\n', 'base');
  stream.push(
    Buffer.from(
      'commit refs/heads/main\nmark :2\n' +
        'author Fixture <fixture@example.invalid> 1000000000 +0000\n' +
        'committer Fixture <fixture@example.invalid> 1000000000 +0000\n',
    ),
  );
  appendData(stream, '', 'baseline');
  stream.push(Buffer.from('M 100644 :1 history.txt\n'));
  let parentMark = 2;
  let nextMark = 3;
  for (let index = 0; index < 110; index += 1) {
    const blobMark = nextMark;
    const commitMark = nextMark + 1;
    appendData(stream, `blob\nmark :${blobMark}\n`, `change-${index}`);
    stream.push(
      Buffer.from(
        `commit refs/heads/main\nmark :${commitMark}\n` +
          'author Fixture <fixture@example.invalid> 1000000000 +0000\n' +
          'committer Fixture <fixture@example.invalid> 1000000000 +0000\n',
      ),
    );
    appendData(stream, '', `commit-${index}`);
    stream.push(
      Buffer.from(`from :${parentMark}\nM 100644 :${blobMark} history.txt\n`),
    );
    parentMark = commitMark;
    nextMark += 2;
  }
  childProcess.execFileSync('git', ['fast-import', '--quiet'], {
    cwd: directory,
    input: Buffer.concat(stream),
  });
  runGit(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const baselineSha = runGit(directory, ['rev-parse', 'refs/heads/main~110']);
  const headSha = runGit(directory, ['rev-parse', 'refs/heads/main']);
  const recentAncestorSha = runGit(directory, [
    'rev-parse',
    'refs/heads/main~1',
  ]);
  runGit(directory, ['update-ref', 'refs/remotes/origin/main', headSha]);

  const unrelatedStream = [];
  appendData(unrelatedStream, 'blob\nmark :1\n', 'unrelated');
  unrelatedStream.push(
    Buffer.from(
      'commit refs/heads/unrelated\n' +
        'author Fixture <fixture@example.invalid> 1000000000 +0000\n' +
        'committer Fixture <fixture@example.invalid> 1000000000 +0000\n',
    ),
  );
  appendData(unrelatedStream, '', 'unrelated-root');
  unrelatedStream.push(Buffer.from('M 100644 :1 unrelated.txt\n'));
  childProcess.execFileSync('git', ['fast-import', '--quiet'], {
    cwd: directory,
    input: Buffer.concat(unrelatedStream),
  });

  const unrelatedSha = runGit(directory, ['rev-parse', 'refs/heads/unrelated']);
  const recentCommits = runGit(directory, [
    'rev-list',
    '--max-count=100',
    'refs/remotes/origin/main',
  ]).split('\n');

  return {
    directory,
    baselineSha,
    headSha,
    recentAncestorSha,
    unrelatedSha,
    recentCommits,
  };
}

function appendData(chunks, prefix, data) {
  const payload = Buffer.from(data);
  chunks.push(
    Buffer.from(`${prefix}data ${payload.length}\n`),
    payload,
    Buffer.from('\n'),
  );
}

function runGit(directory, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function runAction({
  getCode,
  implementationKind,
  candidates,
  targetSha = fixture.headSha,
  targetRefMissing = false,
  shallow = false,
  gitFailure,
  fatal = true,
  directory = fixture.directory,
}) {
  const result = {
    outputs: {},
    workflowRunParams: undefined,
    stdout: '',
    failure: undefined,
  };
  let workingDirectory = process.cwd();
  const core = {
    setOutput(name, value) {
      result.outputs[name] = value;
    },
    setFailed(message) {
      result.failure = String(message);
    },
  };
  const github = {
    context: {
      runId: 456,
      repo: { owner: 'example', repo: 'repo' },
      eventName: 'workflow_dispatch',
      payload: {},
    },
  };
  class FakeOctokit {
    static plugin() {
      return FakeOctokit;
    }

    constructor() {
      this.hook = { before() {} };
    }

    async request(route, params = {}) {
      if (route.includes('/actions/workflows/')) {
        result.workflowRunParams = params;
        return {
          data: {
            workflow_runs: candidates.map((head_sha) => ({
              head_sha,
              head_branch: 'main',
              event: 'workflow_dispatch',
              status: 'success',
            })),
          },
        };
      }
      throw new Error(`Unexpected GitHub request: ${route}`);
    }
  }

  const modules = {
    '@actions/core': core,
    '@actions/github': github,
    '@octokit/action': { Octokit: FakeOctokit },
    child_process: {
      spawnSync(command, args, options = {}) {
        if (command === 'git') {
          if (
            shallow &&
            args.join(' ') === 'rev-parse --is-shallow-repository'
          ) {
            return gitResult(0, 'true\n');
          }
          if (
            targetRefMissing &&
            args[0] === 'rev-parse' &&
            args[1] === '--verify'
          ) {
            return gitResult(128, '', 'fatal: Needed a single revision');
          }
          if (
            args[0] === 'rev-parse' &&
            args[1] === '--verify' &&
            args[2] === 'refs/remotes/origin/main^{commit}'
          ) {
            return gitResult(0, `${targetSha}\n`);
          }
          if (
            gitFailure === 'spawn' &&
            args[0] === 'rev-parse' &&
            args[1] === '--is-shallow-repository'
          ) {
            return {
              ...gitResult(null, '', ''),
              error: Object.assign(new Error('injected spawn failure'), {
                code: 'ENOENT',
              }),
            };
          }
          if (
            gitFailure === 'signal' &&
            args[0] === 'merge-base' &&
            args[1] === '--is-ancestor'
          ) {
            return {
              ...gitResult(null, '', ''),
              signal: 'SIGTERM',
            };
          }
          if (
            gitFailure === 'unexpected-status' &&
            args[0] === 'merge-base' &&
            args[1] === '--is-ancestor'
          ) {
            return gitResult(128, '', '');
          }
          if (
            gitFailure === 'rev-list-count' &&
            args[0] === 'rev-list' &&
            args[1] === '--count'
          ) {
            return gitResult(128, '', 'fatal: injected rev-list failure');
          }
          if (
            gitFailure === 'malformed-object-response' &&
            args[0] === 'cat-file' &&
            args[1]?.startsWith('--batch-check')
          ) {
            return gitResult(0, 'malformed response\n');
          }
          return childProcess.spawnSync(command, args, {
            ...options,
            cwd: workingDirectory,
          });
        }
        return childProcess.spawnSync(command, args, options);
      },
    },
    fs: { existsSync: fs.existsSync },
    'https-proxy-agent': { HttpsProxyAgent: class HttpsProxyAgent {} },
    'proxy-from-env': { getProxyForUrl: () => undefined },
  };
  const fakeProcess = {
    argv: [
      'node',
      'find-successful-workflow',
      'test-token',
      'main',
      String(fatal),
      'workflow_dispatch',
      directory,
      '123',
      '',
    ],
    env: {},
    stdout: {
      write(text) {
        result.stdout += String(text);
      },
    },
    stderr: {
      write(text) {
        result.stdout += String(text);
      },
    },
    chdir(directory) {
      workingDirectory = directory;
    },
    cwd() {
      return workingDirectory;
    },
  };
  const context = {
    process: fakeProcess,
    require(name) {
      if (!(name in modules)) {
        throw new Error(`Unexpected module request: ${name}`);
      }
      return modules[name];
    },
    console: { log() {} },
    URL,
    __dirname: repositoryRoot,
    setTimeout,
    clearTimeout,
    module: { exports: {} },
    exports: {},
  };

  const code = getCode();
  if (implementationKind === 'source') {
    const transpiled = TypeScript.transpileModule(code, {
      compilerOptions: {
        module: TypeScript.ModuleKind.CommonJS,
        target: TypeScript.ScriptTarget.ES2020,
      },
      fileName: sourcePath,
    }).outputText;
    vm.runInNewContext(transpiled, context, { filename: sourcePath });
  } else {
    context.__nxSetShasTestMocks = modules;
    vm.runInNewContext(code, context, { filename: bundlePath });
  }

  const finishedAt = Date.now() + 2_000;
  while (!result.failure && result.outputs.head === undefined) {
    if (Date.now() > finishedAt) {
      throw new Error('Action did not report outputs or a failure');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return result;
}

function makeBundleTestSource() {
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const startup = bundle.match(
    /var __webpack_exports__ = __nccwpck_require__\((\d+)\);/,
  );
  assert.ok(startup, 'could not identify the ncc entry module');
  const entryModuleId = startup[1];
  const moduleStart = bundle.indexOf(`/***/ ${entryModuleId}:`);
  const moduleEnd = bundle.indexOf('/***/ }),', moduleStart);
  assert.ok(moduleStart >= 0 && moduleEnd > moduleStart);
  const entryFactory = bundle.slice(moduleStart, moduleEnd);
  const dependencyIds = [
    ...entryFactory.matchAll(/__nccwpck_require__\((\d+)\)/g),
  ].map((match) => match[1]);
  const mockNames = [
    '@actions/core',
    '@actions/github',
    '@octokit/action',
    'child_process',
    'fs',
    'https-proxy-agent',
    'proxy-from-env',
  ];
  assert.equal(
    dependencyIds.length,
    mockNames.length,
    'ncc entry dependency layout changed; update the in-memory test adapter',
  );

  const replacement = [
    ...new Set(
      dependencyIds.map(
        (id, index) =>
          `__webpack_modules__[${id}] = function(module) { ` +
          `module.exports = globalThis.__nxSetShasTestMocks[${JSON.stringify(
            mockNames[index],
          )}]; };`,
      ),
    ),
  ].join('\n');
  const instrumentedStartup = `${replacement}\n${startup[0]}`;
  assert.equal(
    bundle.split(startup[0]).length - 1,
    1,
    'ncc entry call was not unique',
  );
  return bundle.replace(startup[0], instrumentedStartup);
}

function gitResult(status, stdout, stderr = '') {
  return {
    status,
    signal: null,
    error: undefined,
    stdout,
    stderr,
  };
}
