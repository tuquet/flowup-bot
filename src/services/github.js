import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';

const execAsync = promisify(exec);

// Strip ANSI color escape sequences
function stripAnsi(str) {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Fetch latest workflow runs for a repository
 */
export async function getLatestRuns(repo = config.defaultRepo, limit = 1) {
  try {
    const cmd = `gh run list -R "${repo}" -L ${limit} --json databaseId,status,conclusion,workflowName,headBranch,headSha,event,createdAt,updatedAt,url`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 15000 });
    const cleanOutput = stripAnsi(stdout.trim());
    return JSON.parse(cleanOutput);
  } catch (error) {
    throw new Error(`Failed to fetch workflow runs: ${error.message}`);
  }
}

/**
 * Trigger deployment workflow dispatch
 */
export async function triggerDeploy(repo = config.defaultRepo, workflow = config.deployWorkflow, branch = 'main') {
  try {
    const cmd = `gh workflow run "${workflow}" -R "${repo}" --ref "${branch}"`;
    await execAsync(cmd, { timeout: 15000 });
    return { success: true, message: `Workflow '${workflow}' on branch '${branch}' triggered successfully.` };
  } catch (error) {
    throw new Error(`Failed to trigger workflow: ${error.message}`);
  }
}

/**
 * Get error log summary for a specific or latest failed run
 */
export async function getFailedLogs(repo = config.defaultRepo, runId = null) {
  try {
    let targetRunId = runId;
    let isLatestSuccess = false;
    let latestRunId = null;

    if (!targetRunId) {
      const runs = await getLatestRuns(repo, 3);
      if (!runs || runs.length === 0) {
        return { hasFailed: false, message: 'Không tìm thấy workflow run nào cho repo.' };
      }

      const latestRun = runs[0];
      latestRunId = latestRun.databaseId;

      if (latestRun.conclusion === 'success') {
        isLatestSuccess = true;
        const failedRun = runs.find(r => r.conclusion === 'failure');
        if (!failedRun) {
          return {
            hasFailed: false,
            latestRunId,
            message: `Build gần nhất (Run ID: <code>${latestRunId}</code>) đã <b>THÀNH CÔNG</b> ✅! Không có lỗi nào trong các lần chạy gần đây.`
          };
        }
        targetRunId = failedRun.databaseId;
      } else {
        const failedRun = runs.find(r => r.conclusion === 'failure');
        if (!failedRun) {
          return { hasFailed: false, message: 'Không có workflow run nào bị lỗi trong 3 lần chạy gần nhất.' };
        }
        targetRunId = failedRun.databaseId;
      }
    }

    const cmd = `gh run view ${targetRunId} -R "${repo}" --log-failed`;
    const { stdout } = await execAsync(cmd, { timeout: 20000 });
    const clean = stripAnsi(stdout);
    
    // Take the last 35 lines or 2500 characters
    const lines = clean.split('\n');
    const tailLines = lines.slice(-35).join('\n');
    const trimmed = tailLines.length > 2500 ? tailLines.slice(-2500) : tailLines;

    return {
      hasFailed: true,
      isLatestSuccess,
      latestRunId,
      runId: targetRunId,
      logs: trimmed
    };
  } catch (error) {
    throw new Error(`Failed to fetch error logs: ${error.message}`);
  }
}

/**
 * List recent repositories
 */
export async function listRepos(owner = 'tuquet', limit = 5) {
  try {
    const cmd = `gh repo list "${owner}" -L ${limit} --json name,isPrivate,pushedAt,description,url`;
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    const cleanOutput = stripAnsi(stdout.trim());
    return JSON.parse(cleanOutput);
  } catch (error) {
    throw new Error(`Failed to fetch repo list: ${error.message}`);
  }
}
