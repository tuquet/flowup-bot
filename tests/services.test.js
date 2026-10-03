import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemStats, checkSiteHealth, checkServices } from '../src/services/system.js';
import { getLatestRuns, listRepos, getFailedLogs, resolveRepo, getMultiRepoCiSummary } from '../src/services/github.js';
import { getLatestReleases } from '../src/services/releases.js';
import { isAdmin, isAllowedChat } from '../src/config.js';

describe('System Service Tests', () => {
  test('getSystemStats returns valid system metrics', async () => {
    const stats = await getSystemStats();
    assert.ok(stats.cpus > 0, 'CPU count should be greater than 0');
    assert.ok(stats.loadAvg, 'Load average should be present');
    assert.ok(stats.memory.includes('%'), 'Memory should contain percentage');
    assert.ok(stats.disk, 'Disk info should be present');
    assert.ok(stats.uptime, 'Uptime should be present');
    assert.ok(stats.platform, 'Platform should be present');
  });

  test('checkSiteHealth pings website successfully with SSL', async () => {
    const health = await checkSiteHealth('https://tuquet.github.io/');
    assert.equal(health.status, 200, 'HTTP status should be 200');
    assert.equal(health.isOk, true, 'Site health isOk should be true');
    assert.ok(health.latency > 0, 'Latency should be measured');
    assert.ok(typeof health.sslDays === 'number' && health.sslDays > 0, 'SSL days remaining should be positive');
  });

  test('checkServices detects active systemd services', async () => {
    const results = await checkServices(['flowup-bot']);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'flowup-bot');
    assert.equal(results[0].status, 'active');
    assert.equal(results[0].active, true);
  });
});

describe('GitHub & Releases Service Tests', () => {
  test('getLatestRuns fetches workflow runs from GitHub', async () => {
    const runs = await getLatestRuns('tuquet/tuquet.github.io', 1);
    assert.ok(Array.isArray(runs), 'Runs should be an array');
    assert.ok(runs.length >= 1, 'Should return at least 1 run');
    assert.ok(runs[0].databaseId, 'Database ID should be present');
    assert.ok(runs[0].status, 'Status should be present');
  });

  test('listRepos fetches repositories for user tuquet', async () => {
    const repos = await listRepos('tuquet', 3);
    assert.ok(Array.isArray(repos), 'Repos should be an array');
    assert.ok(repos.length > 0, 'Should return at least 1 repository');
    assert.ok(repos[0].name, 'Repo should have a name');
    assert.ok(repos[0].url, 'Repo should have a url');
  });

  test('getFailedLogs handles error log queries gracefully', async () => {
    const result = await getFailedLogs('tuquet/tuquet.github.io');
    assert.ok(typeof result.hasFailed === 'boolean');
    if (!result.hasFailed) {
      assert.ok(result.message);
    } else {
      assert.ok(result.logs);
    }
  });

  test('getLatestReleases fetches releases from Netlify portal or RSS', async () => {
    const releases = await getLatestReleases(3);
    assert.ok(Array.isArray(releases), 'Releases should be an array');
    assert.ok(releases.length > 0, 'Should return at least 1 release');
    assert.ok(releases[0].repo, 'Release should have a repo property');
    assert.ok(releases[0].version, 'Release should have a version property');
    assert.ok(releases[0].url, 'Release should have a url property');
  });

  test('resolveRepo normalizes short repo names to tuquet/repo', () => {
    assert.equal(resolveRepo('releases'), 'tuquet/releases');
    assert.equal(resolveRepo('tuquet/cloud'), 'tuquet/cloud');
    assert.equal(resolveRepo('all'), 'all');
    assert.equal(resolveRepo(''), 'tuquet/tuquet.github.io');
  });

  test('getMultiRepoCiSummary fetches latest workflow info for multiple repos', async () => {
    const summary = await getMultiRepoCiSummary(['tuquet/tuquet.github.io', 'tuquet/releases']);
    assert.equal(summary.length, 2);
    assert.equal(summary[0].repo, 'tuquet/tuquet.github.io');
    assert.equal(summary[0].hasRun, true);
    assert.equal(summary[1].repo, 'tuquet/releases');
    assert.equal(summary[1].hasRun, true);
    assert.equal(summary[1].conclusion, 'success');
  });
});

describe('Config & Auth Tests', () => {
  test('isAdmin accurately verifies admin user IDs', () => {
    assert.equal(isAdmin('1038133235'), true, 'Tu Dinh ID should be admin');
    assert.equal(isAdmin(1038133235), true, 'Number ID should also be valid');
    assert.equal(isAdmin('999999999'), false, 'Random user should not be admin');
    assert.equal(isAdmin(null), false, 'Null should not be admin');
  });

  test('isAllowedChat verifies whitelisted chat IDs', () => {
    assert.equal(isAllowedChat('-5079028223'), true, 'Bot Notification group should be allowed');
    assert.equal(isAllowedChat(-5079028223), true, 'Bot Notification number ID should be allowed');
    assert.equal(isAllowedChat('1038133235'), true, 'Admin private chat should be allowed');
    assert.equal(isAllowedChat(-750035888), false, 'Tu Quet group should be denied');
    assert.equal(isAllowedChat('-999999999'), false, 'Non-whitelisted group should be denied');
  });
});
