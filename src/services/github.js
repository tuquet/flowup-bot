import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
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

/**
 * Normalize repository input to full "owner/repo" form
 */
export function resolveRepo(name) {
  if (!name) return config.defaultRepo;
  const trimmed = name.trim();
  if (trimmed === 'all') return 'all';
  if (trimmed.includes('/')) return trimmed;
  return `tuquet/${trimmed}`;
}

/**
 * Fetch latest CI summary for multiple repositories
 */
export async function getMultiRepoCiSummary(repos = config.monitoredRepos) {
  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      try {
        const runs = await getLatestRuns(repo, 1);
        if (!runs || runs.length === 0) {
          return { repo, hasRun: false };
        }
        const run = runs[0];
        return {
          repo,
          hasRun: true,
          status: run.status,
          conclusion: run.conclusion,
          workflowName: run.workflowName,
          databaseId: run.databaseId,
          url: run.url,
          headBranch: run.headBranch,
          updatedAt: run.updatedAt,
        };
      } catch (err) {
        return { repo, hasRun: false, error: err.message };
      }
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : { repo: 'unknown', hasRun: false });
}

/**
 * Monitor CI runs across repositories and broadcast status changes (failures & recoveries)
 */
export async function checkForCiUpdates(bot) {
  const trackerFile = path.join(config.dataDir, 'ci_tracker.json');
  try {
    let state = {};
    if (fs.existsSync(trackerFile)) {
      try {
        state = JSON.parse(fs.readFileSync(trackerFile, 'utf8'));
      } catch (e) {
        state = {};
      }
    }

    const summaries = await getMultiRepoCiSummary(config.monitoredRepos);
    const targetChats = config.techChats.length > 0 ? config.techChats : (config.broadcastChats.length > 0 ? config.broadcastChats : config.allowedChats);
    const isInitialRun = Object.keys(state).length === 0;

    for (const item of summaries) {
      if (!item.hasRun) continue;

      const prev = state[item.repo];
      const currentRunId = item.databaseId;
      const currentConclusion = item.conclusion;
      const currentStatus = item.status;

      // Update state in memory
      state[item.repo] = {
        lastRunId: currentRunId,
        status: currentStatus,
        conclusion: currentConclusion,
        updatedAt: item.updatedAt,
      };

      if (isInitialRun) {
        continue; // Do not spam on bot reboot/initialization
      }

      // Detect if this run is completed
      if (currentStatus === 'completed') {
        const wasFailure = prev?.conclusion === 'failure';
        const isNewRun = !prev || prev.lastRunId !== currentRunId;

        // Condition 1: Newly failed run
        if (currentConclusion === 'failure' && (isNewRun || !wasFailure)) {
          console.log(`[CI Monitor] Detected workflow failure on ${item.repo}`);
          let errorExcerpt = '';
          try {
            const logRes = await getFailedLogs(item.repo, currentRunId);
            if (logRes.hasFailed && logRes.logs) {
              const lastLines = logRes.logs.split('\n').slice(-15).join('\n');
              errorExcerpt = `\n\n<b>📜 Trích xuất lỗi:</b>\n<pre>${stripAnsi(lastLines).slice(-1200)}</pre>`;
            }
          } catch (e) {
            // ignore log fetch failure
          }

          const msg = [
            `🚨 <b>CẢNH BÁO CI THẤT BẠI: <code>${item.repo}</code></b>`,
            `⚙️ <b>Workflow:</b> ${item.workflowName}`,
            `🌿 <b>Nhánh:</b> <code>${item.headBranch}</code>`,
            `📌 <b>Trạng thái:</b> ❌ <b>failure</b>`,
            errorExcerpt,
            ``,
            `🔗 <a href="${item.url}">Xem chi tiết trên GitHub Actions</a>`,
          ].filter(Boolean).join('\n');

          for (const chatId of targetChats) {
            await bot.api.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
          }
        }

        // Condition 2: Recovery to success after failure
        if (currentConclusion === 'success' && wasFailure && isNewRun) {
          console.log(`[CI Monitor] Detected workflow recovery on ${item.repo}`);
          const msg = [
            `🎉 <b>CI ĐÃ XANH TRỞ LẠI: <code>${item.repo}</code></b>`,
            `⚙️ <b>Workflow:</b> ${item.workflowName}`,
            `🌿 <b>Nhánh:</b> <code>${item.headBranch}</code>`,
            `📌 <b>Trạng thái:</b> ✅ <b>success</b>`,
            ``,
            `🔗 <a href="${item.url}">Xem chi tiết trên GitHub Actions</a>`,
          ].join('\n');

          for (const chatId of targetChats) {
            await bot.api.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
          }
        }

        // Condition 3: Deploy or successful build on website / release workflows
        if (currentConclusion === 'success' && isNewRun && !wasFailure) {
          if (item.repo === 'tuquet/tuquet.github.io' || item.workflowName.toLowerCase().includes('deploy') || item.workflowName.toLowerCase().includes('release')) {
            console.log(`[CI Monitor] Detected successful deploy/run on ${item.repo}`);
            const msg = [
              `🚀 <b>BUILD & DEPLOY THÀNH CÔNG: <code>${item.repo}</code></b>`,
              `⚙️ <b>Workflow:</b> ${item.workflowName}`,
              `🌿 <b>Nhánh:</b> <code>${item.headBranch}</code>`,
              `📌 <b>Trạng thái:</b> ✅ <b>success</b>`,
              ``,
              `🌐 <a href="${config.websiteUrl}">Mở Website</a> | <a href="${item.url}">Xem trên GitHub</a>`,
            ].join('\n');

            for (const chatId of targetChats) {
              await bot.api.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: false }).catch(() => {});
            }
          }
        }
      }
    }

    fs.writeFileSync(trackerFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[CI Monitor] Error monitoring CI workflows:', err.message);
  }
}

