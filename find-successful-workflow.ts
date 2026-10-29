import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/action';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

const {
  runId,
  repo: { repo, owner },
  eventName,
} = github.context;
process.env.GITHUB_TOKEN = process.argv[2];
const mainBranchName = process.argv[3];
const errorOnNoSuccessfulWorkflow = process.argv[4];
const lastSuccessfulEvent = process.argv[5];
const workingDirectory = process.argv[6];
const workflowId = process.argv[7];
const fallbackSHA = process.argv[8];
const defaultWorkingDirectory = '.';

const ProxifiedClient = Octokit.plugin(proxyPlugin);

const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

let BASE_SHA: string;
(async () => {
  if (workingDirectory !== defaultWorkingDirectory) {
    if (existsSync(workingDirectory)) {
      process.chdir(workingDirectory);
    } else {
      process.stdout.write('\n');
      process.stdout.write(
        `WARNING: Working directory '${workingDirectory}' doesn't exist.\n`,
      );
    }
  }

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  });
  const HEAD_SHA = headResult.stdout;

  if (
    (['pull_request', 'pull_request_target'].includes(eventName) &&
      !github.context.payload.pull_request.merged) ||
    eventName == 'merge_group'
  ) {
    try {
      const mergeBaseRef = await findMergeBaseRef();
      const baseResult = spawnSync(
        'git',
        ['merge-base', `origin/${mainBranchName}`, mergeBaseRef],
        { encoding: 'utf-8' },
      );
      BASE_SHA = baseResult.stdout;
    } catch (e) {
      core.setFailed(e.message);
      return;
    }
  } else {
    try {
      BASE_SHA = await findSuccessfulCommit(
        workflowId,
        runId,
        owner,
        repo,
        mainBranchName,
        lastSuccessfulEvent,
      );
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow === 'true') {
        reportFailure(mainBranchName);
        return;
      } else {
        process.stdout.write('\n');
        process.stdout.write(
          `WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}', or the latest successful workflow was connected to a commit which no longer exists on that branch (e.g. if that branch was rebased)\n`,
        );
        if (fallbackSHA) {
          BASE_SHA = fallbackSHA;
          process.stdout.write(`Using provided fallback SHA: ${fallbackSHA}\n`);
        } else {
          process.stdout.write(
            `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`,
          );
          process.stdout.write('\n');
          process.stdout.write(
            `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`,
          );
          process.stdout.write('\n');

          try {
            const commitCountResult = spawnSync(
              'git',
              ['rev-list', '--count', `origin/${mainBranchName}`],
              { encoding: 'utf-8' },
            );
            assertGitSucceeded(
              `count commits on origin/${mainBranchName}`,
              commitCountResult,
            );
            const commitCount = parseInt(
              stripNewLineEndings(String(commitCountResult.stdout)),
              10,
            );
            if (Number.isNaN(commitCount)) {
              throw new Error(
                `Git returned an invalid commit count for origin/${mainBranchName}: '${String(
                  commitCountResult.stdout,
                ).trim()}'`,
              );
            }

            const LAST_COMMIT_CMD = `origin/${mainBranchName}${
              commitCount > 1 ? '~1' : ''
            }`;
            const baseRes = spawnSync('git', ['rev-parse', LAST_COMMIT_CMD], {
              encoding: 'utf-8',
            });
            assertGitSucceeded(`resolve ${LAST_COMMIT_CMD}`, baseRes);
            BASE_SHA = baseRes.stdout;
          } catch (e) {
            core.setFailed(e.message);
            return;
          }
        }
        core.setOutput('noPreviousBuild', 'true');
      }
    } else {
      process.stdout.write('\n');
      process.stdout.write(
        `Found the last successful workflow run on 'origin/${mainBranchName}'\n`,
      );
      process.stdout.write(`Commit: ${BASE_SHA}\n`);
    }
  }
  core.setOutput('base', stripNewLineEndings(BASE_SHA));
  core.setOutput('head', stripNewLineEndings(HEAD_SHA));
})();

function reportFailure(branchName: string): void {
  core.setFailed(`
    Unable to find a successful workflow run on 'origin/${branchName}'
    NOTE: You have set 'error-on-no-successful-workflow' on the action so this is a hard error.

    Is it possible that you have no runs currently on 'origin/${branchName}'?
    - If yes, then you should run the workflow without this flag first.
    - If no, then you might have changed your git history and those commits no longer exist.`);
}

function proxyPlugin(octokit: Octokit): void {
  octokit.hook.before('request', (options) => {
    const proxy: URL = getProxyForUrl(options.baseUrl);
    if (proxy) {
      options.request.agent = new HttpsProxyAgent(proxy);
    }
  });
}

/**
 * Find last successful workflow run on the repo
 */
async function findSuccessfulCommit(
  workflow_id: string | undefined,
  run_id: number,
  owner: string,
  repo: string,
  branch: string,
  lastSuccessfulEvent: string,
): Promise<string | undefined> {
  const octokit = new ProxifiedClient();
  if (!workflow_id) {
    workflow_id = await octokit
      .request(`GET /repos/${owner}/${repo}/actions/runs/${run_id}`, {
        owner,
        repo,
        branch,
        run_id,
      })
      .then(({ data: { workflow_id } }) => workflow_id);
    process.stdout.write('\n');
    process.stdout.write(
      `Workflow Id not provided. Using workflow '${workflow_id}'\n`,
    );
  }

  const workflowRunsFetchParams = {
    owner,
    repo,
    // on some workflow runs we do not have branch property
    branch:
      lastSuccessfulEvent === 'push' ||
      lastSuccessfulEvent === 'workflow_dispatch'
        ? branch
        : undefined,
    workflow_id,
    event: lastSuccessfulEvent,
    status: 'success',
  };

  function printObjectOneLine(obj) {
    let result = '';
    for (const [key, value] of Object.entries(obj)) {
      result += `${key}: ${value}, `;
    }
    // Remove the trailing comma and space
    result = result.slice(0, -2);
    console.log(result);
  }

  process.stdout.write('\n');
  process.stdout.write(`workflowRunsFetchParams\n`);
  process.stdout.write(`${printObjectOneLine(workflowRunsFetchParams)}`);

  // fetch all workflow runs on a given repo/branch/workflow with push and success
  const shas = await octokit
    .request(
      `GET /repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`,
      workflowRunsFetchParams,
    )
    .then((response) => {
      const {
        data: { workflow_runs },
      } = response;
      process.stdout.write('\n');
      process.stdout.write(`workflow runs fetch result:\n`);
      workflow_runs.slice(0, 5).forEach((run) => {
        process.stdout.write(
          JSON.stringify({
            head_branch: run.head_branch,
            head_sha: run.head_sha,
            event: run.event,
            status: run.status,
          }),
        );
        process.stdout.write('\n');
      });
      return response;
    })
    .then(({ data: { workflow_runs } }) =>
      workflow_runs.map((run: { head_sha: any }) => run.head_sha),
    );

  return findExistingCommit(branch, shas);
}

async function findMergeBaseRef(): Promise<string> {
  if (eventName == 'merge_group') {
    const mergeQueueBranch = await findMergeQueueBranch();
    return `origin/${mergeQueueBranch}`;
  } else {
    return 'HEAD';
  }
}

function findMergeQueuePr(): string {
  const { head_ref, base_sha } = github.context.payload.merge_group;
  const result = new RegExp(
    `^refs/heads/gh-readonly-queue/${mainBranchName}/pr-(\\d+)-${base_sha}$`,
  ).exec(head_ref);
  return result ? result.at(1) : undefined;
}

async function findMergeQueueBranch(): Promise<string> {
  const pull_number = findMergeQueuePr();
  if (!pull_number) {
    throw new Error('Failed to determine PR number');
  }
  process.stdout.write('\n');
  process.stdout.write(`Found PR #${pull_number} from merge queue branch\n`);
  const octokit = new ProxifiedClient();
  const result = await octokit.request(
    `GET /repos/${owner}/${repo}/pulls/${pull_number}`,
    { owner, repo, pull_number: +pull_number },
  );
  return result.data.head.ref;
}

/**
 * Get first existing commit
 */
function findExistingCommit(
  branchName: string,
  shas: string[],
): string | undefined {
  if (shas.length === 0) {
    return undefined;
  }

  const targetSha = resolveTargetBranchSha(branchName);
  for (const commitSha of shas) {
    if (commitExists(branchName, targetSha, commitSha)) {
      return commitSha;
    }
  }
  return undefined;
}

/**
 * Check whether a candidate commit is usable as a baseline: it must be a
 * well-formed SHA, present and readable in the local object database, a commit
 * object, and an ancestor of the target branch tip.
 *
 * Returns false (skip) for a genuinely absent object or a non-ancestor commit.
 * Throws on malformed SHAs, unreadable/corrupt objects, non-commit objects and
 * any Git failure, so callers abort instead of silently falling back.
 */
function commitExists(
  branchName: string,
  targetSha: string,
  commitSha: string,
): boolean {
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new Error(
      `Successful workflow returned an invalid commit SHA: '${commitSha}'`,
    );
  }

  // Keep diagnostic traces out of this check's stderr so object-read errors
  // remain fatal. Disable tracing only in this subprocess, not the action.
  const objectEnv = { ...process.env };
  for (const name of Object.keys(objectEnv)) {
    if (name.startsWith('GIT_TRACE')) {
      objectEnv[name] = '0';
    }
  }
  const objectResult = spawnSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    {
      encoding: 'utf-8',
      input: `${commitSha}\n`,
      env: objectEnv,
    },
  );
  assertGitSucceeded(`check candidate commit '${commitSha}'`, objectResult);
  // `cat-file --batch-check` can exit 0 and print "<sha> missing" for a
  // corrupt/unreadable object, reporting the real cause only on stderr. A
  // genuinely absent object produces no stderr output.
  const objectStderr = String(objectResult.stderr ?? '').trim();
  if (objectStderr) {
    throw new Error(
      `Git failed to check candidate commit '${commitSha}': ${objectStderr}`,
    );
  }

  const objectFields = String(objectResult.stdout).trim().split(/\s+/);
  if (
    objectFields.length !== 2 ||
    objectFields[0].toLowerCase() !== commitSha.toLowerCase()
  ) {
    throw new Error(
      `Git returned an invalid object check for candidate '${commitSha}'`,
    );
  }
  if (objectFields[1] === 'missing') {
    process.stdout.write(
      `WARNING: Successful workflow candidate '${commitSha}' is missing from local Git objects; skipping it.\n`,
    );
    return false;
  }
  if (objectFields[1] !== 'commit') {
    throw new Error(
      `Successful workflow candidate '${commitSha}' is a ${objectFields[1]} object, not a commit`,
    );
  }

  const ancestryResult = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', commitSha, targetSha],
    { encoding: 'utf-8' },
  );
  if (
    !ancestryResult.error &&
    !ancestryResult.signal &&
    ancestryResult.status === 0
  ) {
    return true;
  }
  if (
    !ancestryResult.error &&
    !ancestryResult.signal &&
    ancestryResult.status === 1
  ) {
    process.stdout.write(
      `WARNING: Successful workflow candidate '${commitSha}' is not an ancestor of origin/${branchName} (${targetSha}); skipping it.\n`,
    );
    return false;
  }

  throw gitValidationError(
    `validate whether '${commitSha}' is an ancestor of origin/${branchName}`,
    ancestryResult,
  );
}

function resolveTargetBranchSha(branchName: string): string {
  const shallowResult = spawnSync(
    'git',
    ['rev-parse', '--is-shallow-repository'],
    { encoding: 'utf-8' },
  );
  assertGitSucceeded('check whether the checkout is shallow', shallowResult);
  const shallowStatus = String(shallowResult.stdout).trim();
  if (shallowStatus === 'true') {
    throw new Error(
      `Cannot validate successful workflow baselines: the Git checkout is shallow; fetch complete history and origin/${branchName}`,
    );
  }
  if (shallowStatus !== 'false') {
    throw new Error(
      `Git returned an invalid shallow-check result: '${shallowStatus}'`,
    );
  }

  const targetRef = `refs/remotes/origin/${branchName}^{commit}`;
  const targetResult = spawnSync('git', ['rev-parse', '--verify', targetRef], {
    encoding: 'utf-8',
  });
  assertGitSucceeded(
    `resolve target branch origin/${branchName}`,
    targetResult,
  );
  const targetSha = String(targetResult.stdout).trim();
  if (!COMMIT_SHA_PATTERN.test(targetSha)) {
    throw new Error(
      `Git returned an invalid commit SHA for origin/${branchName}: '${targetSha}'`,
    );
  }
  return targetSha;
}

function assertGitSucceeded(
  operation: string,
  result: ReturnType<typeof spawnSync>,
): void {
  if (result.error || result.signal || result.status !== 0) {
    throw gitValidationError(operation, result);
  }
}

function gitValidationError(
  operation: string,
  result: ReturnType<typeof spawnSync>,
): Error {
  let detail = result.stderr ? String(result.stderr).trim() : '';
  if (result.error) {
    detail = result.error.message;
  } else if (result.signal) {
    detail = `process terminated by ${result.signal}`;
  } else if (!detail) {
    detail = `exit status ${result.status}`;
  }
  return new Error(`Git failed to ${operation}: ${detail}`);
}

/**
 * Strips LF line endings from given string
 */
function stripNewLineEndings(string: string): string {
  return string.replace('\n', '');
}
