import { Bot, InlineKeyboard } from 'grammy';
import { config, isAdmin, isAllowedChat } from './config.js';
import { getLatestRuns, triggerDeploy, getFailedLogs, listRepos, resolveRepo, getMultiRepoCiSummary, checkForCiUpdates } from './services/github.js';
import { getSystemStats, checkSiteHealth, checkServices } from './services/system.js';
import { getLatestReleases, checkForNewReleases, checkForNewBlogPosts } from './services/releases.js';

if (!config.token) {
  console.error('[Error] TELEGRAM_BOT_TOKEN is not set in config/.env');
  process.exit(1);
}

const bot = new Bot(config.token);

// Escape HTML special characters
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Helper to create main keyboard
function getMainKeyboard() {
  return new InlineKeyboard()
    .text('📊 CI Status', 'action:ci')
    .text('🚀 Deploy Website', 'action:deploy_confirm')
    .row()
    .text('🌐 Site Health', 'action:site')
    .text('💻 Server VPS', 'action:server')
    .row()
    .text('📦 Releases', 'action:releases')
    .text('📂 Repos', 'action:repos')
    .row()
    .text('📜 Error Logs', 'action:logs');
}

// Global Chat Whitelist Middleware
bot.use(async (ctx, next) => {
  // Handle group to supergroup migration dynamically
  if (ctx.message?.migrate_to_chat_id) {
    const newChatId = String(ctx.message.migrate_to_chat_id);
    const oldChatId = String(ctx.chat.id);
    console.log(`[Bot] Chat migrated from ${oldChatId} to ${newChatId}`);
    if (isAllowedChat(oldChatId) && !config.allowedChats.includes(newChatId)) {
      config.allowedChats.push(newChatId);
      if (config.techChats.includes(oldChatId) && !config.techChats.includes(newChatId)) {
        config.techChats.push(newChatId);
      }
      if (config.announcementChats.includes(oldChatId) && !config.announcementChats.includes(newChatId)) {
        config.announcementChats.push(newChatId);
      }
    }
    return;
  }

  // Allow Admin to check /id or /chatid in any chat to easily obtain chat IDs
  const text = ctx.message?.text || '';
  if (text.startsWith('/id') || text.startsWith('/chatid')) {
    if (isAdmin(ctx.from?.id)) {
      const isTech = config.techChats.includes(String(ctx.chat.id));
      const isAnnounce = config.announcementChats.includes(String(ctx.chat.id));
      const roleDesc = isTech ? '🛠️ Nhóm Tech/DevOps' : (isAnnounce ? '📢 Nhóm Announcement' : 'Chưa phân loại');
      await ctx.reply(
        `🆔 <b>Thông tin phòng chat:</b>\n` +
        `• <b>Tên:</b> ${escapeHtml(ctx.chat.title || ctx.chat.first_name || 'Private')}\n` +
        `• <b>Chat ID:</b> <code>${ctx.chat.id}</code>\n` +
        `• <b>Loại:</b> <code>${ctx.chat.type}</code>\n` +
        `• <b>Phân loại:</b> ${roleDesc}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }
  }

  if (ctx.chat && !isAllowedChat(ctx.chat.id)) {
    console.log(`[Blocked] Unauthorized chat ID: ${ctx.chat.id} (${ctx.chat.title || 'private'})`);
    return;
  }
  await next();
});

// Welcome message when bot is added to a group or channel
bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember?.new_chat_member?.status;
  if (['member', 'administrator'].includes(status)) {
    console.log(`[Bot] Bot status updated in chat "${ctx.chat.title || ctx.chat.id}" (${ctx.chat.id}): ${status}`);
    const isTech = config.techChats.includes(String(ctx.chat.id));
    const isAnnounce = config.announcementChats.includes(String(ctx.chat.id));
    const roleText = isTech ? ' (🛠️ Kênh Kỹ Thuật & CI/CD)' : (isAnnounce ? ' (📢 Kênh Thông Báo & Releases)' : '');
    await ctx.reply(
      `👋 <b>Chào mừng bạn đến với Flowup Bot (@FlowupAI_bot)!</b>\n\n` +
      `📌 <b>Chat ID:</b> <code>${ctx.chat.id}</code>${roleText}\n\n` +
      `Bot đã sẵn sàng kết nối. Gõ /help hoặc /start để xem các chức năng hỗ trợ.`,
      { parse_mode: 'HTML', reply_markup: getMainKeyboard() }
    ).catch(() => {});
  }
});

// Set Bot Commands for Telegram autocomplete menu
async function setupBotCommands() {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Bảng điều khiển & nút bấm nhanh' },
      { command: 'help', description: 'Hướng dẫn sử dụng các câu lệnh' },
      { command: 'ci', description: 'Trạng thái CI (/ci, /ci all, /ci <repo>)' },
      { command: 'deploy', description: 'Kích hoạt deploy website tức thì' },
      { command: 'releases', description: 'Xem danh sách các release mới nhất' },
      { command: 'logs', description: 'Xem log lỗi (/logs [repo])' },
      { command: 'site', description: 'Kiểm tra uptime & SSL website' },
      { command: 'server', description: 'Giám sát CPU, RAM, Disk VPS' },
      { command: 'services', description: 'Trạng thái các service hệ thống' },
      { command: 'repos', description: 'Xem danh sách repo GitHub gần nhất' },
    ]);
    console.log('[Bot] Registered Telegram slash commands successfully.');
  } catch (err) {
    console.warn('[Bot] Failed to set bot commands:', err.message);
  }
}

// Format Multi-Repo CI Overview Message
async function formatMultiRepoCiMessage() {
  const list = await getMultiRepoCiSummary(config.monitoredRepos);
  const rows = list.map(item => {
    const shortName = item.repo.replace(/^tuquet\//, '');
    if (!item.hasRun) {
      return `⚪ <b>${escapeHtml(shortName)}:</b> <i>chưa có workflow</i>`;
    }
    const emoji = item.conclusion === 'success' ? '🟢' : item.conclusion === 'failure' ? '🔴' : '🔄';
    const statusStr = item.conclusion || item.status;
    return `${emoji} <b><a href="${escapeHtml(item.url)}">${escapeHtml(shortName)}</a>:</b> <code>${escapeHtml(statusStr)}</code> (<i>${escapeHtml(item.workflowName)}</i>)`;
  });

  const text = [
    `<b>📊 Tổng Quan CI/CD Hệ Sinh Thái Repositories:</b>`,
    ``,
    rows.join('\n'),
    ``,
    `<i>Gõ <code>/ci &lt;tên_repo&gt;</code> để xem chi tiết hoặc <code>/logs &lt;tên_repo&gt;</code> để lấy log lỗi.</i>`
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('🔄 Làm mới', 'action:ci_all')
    .row()
    .text('🔙 Menu chính', 'action:help');

  return { text, keyboard };
}

// Format CI Status Message
async function formatCiMessage(repo = config.defaultRepo) {
  const runs = await getLatestRuns(repo, 1);
  if (!runs || runs.length === 0) {
    return {
      text: `⚠️ Không tìm thấy workflow run nào cho repo <code>${escapeHtml(repo)}</code>.`,
      keyboard: new InlineKeyboard().text('🌐 Xem tất cả Repos', 'action:ci_all').row().text('🔙 Menu chính', 'action:help')
    };
  }

  const run = runs[0];
  let statusEmoji = '⏳';
  if (run.status === 'completed') {
    statusEmoji = run.conclusion === 'success' ? '✅' : '❌';
  } else if (run.status === 'in_progress') {
    statusEmoji = '🔄';
  }

  const sha = run.headSha ? run.headSha.substring(0, 7) : 'unknown';
  const createdAt = new Date(run.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const text = [
    `<b>📊 GitHub Actions Status</b>`,
    `📂 <b>Repo:</b> <code>${escapeHtml(repo)}</code>`,
    `⚙️ <b>Workflow:</b> ${escapeHtml(run.workflowName)}`,
    `📌 <b>Trạng thái:</b> ${statusEmoji} <b>${escapeHtml(run.conclusion || run.status)}</b>`,
    `🌿 <b>Nhánh:</b> <code>${escapeHtml(run.headBranch)}</code> (<code>${sha}</code>)`,
    `🎯 <b>Event:</b> <code>${escapeHtml(run.event)}</code>`,
    `🕒 <b>Thời gian:</b> ${createdAt}`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .url('🔗 Xem trên GitHub', run.url || `https://github.com/${repo}/actions`)
    .text('🔄 Làm mới', `action:ci:${repo}`)
    .row()
    .text('🌐 Xem tất cả Repos', 'action:ci_all')
    .row()
    .text('🔙 Menu chính', 'action:help');

  return { text, keyboard };
}

// Format Server Stats Message
async function formatServerMessage() {
  const stats = await getSystemStats();
  const text = [
    `<b>💻 Thông Tin Máy Chủ VPS</b>`,
    `⚡ <b>CPU:</b> ${stats.cpus} cores (Load: <code>${stats.loadAvg}</code>)`,
    `🧠 <b>RAM:</b> <code>${stats.memory}</code>`,
    `💾 <b>Ổ cứng (/):</b> <code>${stats.disk}</code>`,
    `⏱️ <b>Uptime:</b> ${stats.uptime}`,
    `🐧 <b>Hệ điều hành:</b> <code>${stats.platform}</code>`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('🔄 Cập nhật', 'action:server')
    .text('🔍 Services', 'action:services')
    .row()
    .text('🔙 Menu chính', 'action:help');

  return { text, keyboard };
}

// Format Site Health Message
async function formatSiteMessage(url = config.websiteUrl) {
  const health = await checkSiteHealth(url);
  const statusEmoji = health.isOk ? '✅' : '❌';
  const sslText = health.sslDays !== null ? `${health.sslDays} ngày` : 'N/A';

  const text = [
    `<b>🌐 Kiểm Tra Website Health</b>`,
    `🔗 <b>URL:</b> ${escapeHtml(health.url)}`,
    `📡 <b>Status:</b> ${statusEmoji} <code>${health.status} ${escapeHtml(health.statusText)}</code>`,
    `⚡ <b>Độ trễ:</b> <code>${health.latency} ms</code>`,
    `🔒 <b>Chứng chỉ SSL:</b> Còn <b>${sslText}</b>`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .url('🌍 Mở Website', health.url)
    .text('🔄 Đo lại', 'action:site')
    .row()
    .text('🔙 Menu chính', 'action:help');

  return { text, keyboard };
}

// Format Releases Message
async function formatReleasesMessage() {
  const releases = await getLatestReleases(5);
  if (!releases || releases.length === 0) {
    return {
      text: '⚠️ Không thể tải danh sách releases từ portal.',
      keyboard: new InlineKeyboard().text('🔙 Menu chính', 'action:help')
    };
  }

  const lines = releases.map((r, i) => {
    const date = new Date(r.createdAt).toLocaleDateString('vi-VN');
    return `${i + 1}. <b><a href="${escapeHtml(r.url)}">${escapeHtml(r.repo)}</a></b> (<code>${escapeHtml(r.version)}</code>) - <i>${date}</i>\n   ${escapeHtml(r.title)}`;
  });

  const text = [
    `<b>📦 Danh Sách Releases Gần Đây:</b>`,
    `📡 <i>Nguồn: <a href="${escapeHtml(config.releasesFeedUrl)}">tuquet.netlify.app/feed.xml</a></i>`,
    ``,
    lines.join('\n\n')
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .url('🌐 Mở Releases Portal', 'https://tuquet.netlify.app/')
    .text('🔄 Làm mới', 'action:releases')
    .row()
    .text('🔙 Menu chính', 'action:help');

  return { text, keyboard };
}

// ================= COMMAND HANDLERS =================

// /start & /help
bot.command(['start', 'help'], async (ctx) => {
  const name = escapeHtml(ctx.from?.first_name || 'bạn');
  const welcomeText = [
    `👋 <b>Xin chào ${name}!</b>`,
    `Tôi là <b>@FlowupAI_bot</b>, trợ lý DevOps & giám sát hạ tầng.`,
    ``,
    `<b>Các câu lệnh hỗ trợ:</b>`,
    `• <code>/ci</code> - Trạng thái build GitHub Actions`,
    `• <code>/deploy</code> - Kích hoạt deploy website tức thì`,
    `• <code>/releases</code> - Danh sách các release phần mềm mới nhất`,
    `• <code>/logs</code> - Xem tóm tắt log lỗi nếu build fail`,
    `• <code>/site</code> - Uptime và hạn chứng chỉ SSL`,
    `• <code>/server</code> - Tài nguyên CPU, RAM, Disk VPS`,
    `• <code>/services</code> - Trạng thái các service hệ thống`,
    `• <code>/repos</code> - Danh sách kho mã nguồn GitHub`,
    ``,
    `<i>Bấm vào các nút bên dưới để thực thi nhanh:</i>`
  ].join('\n');

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: getMainKeyboard(),
  });
});

// /ci or /status
bot.command(['ci', 'status'], async (ctx) => {
  try {
    const rawArg = ctx.match ? ctx.match.trim() : '';
    if (rawArg.toLowerCase() === 'all') {
      const { text, keyboard } = await formatMultiRepoCiMessage();
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
      return;
    }

    const targetRepo = rawArg ? resolveRepo(rawArg) : config.defaultRepo;
    const { text, keyboard } = await formatCiMessage(targetRepo);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi lấy thông tin CI: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /deploy
bot.command('deploy', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply('⛔ <b>Từ chối truy cập:</b> Chỉ Admin mới có quyền kích hoạt deploy.', { parse_mode: 'HTML' });
    return;
  }

  try {
    await ctx.reply(`⏳ <b>Đang gửi yêu cầu kích hoạt deploy cho repo <code>${escapeHtml(config.defaultRepo)}</code>...</b>`, { parse_mode: 'HTML' });
    await triggerDeploy(config.defaultRepo, config.deployWorkflow, 'main');
    await ctx.reply(
      `🚀 <b>Deploy đã được kích hoạt thành công!</b>\nWorkflow <code>${escapeHtml(config.deployWorkflow)}</code> đang chạy trên GitHub Actions. Kết quả sẽ được gửi tự động khi hoàn thành.`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('📊 Xem tiến độ CI', 'action:ci'),
      }
    );
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi kích hoạt deploy: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /logs
bot.command('logs', async (ctx) => {
  try {
    const rawArg = ctx.match ? ctx.match.trim() : '';
    const targetRepo = rawArg ? resolveRepo(rawArg) : config.defaultRepo;
    const res = await getFailedLogs(targetRepo);
    if (!res.hasFailed) {
      await ctx.reply(`✅ ${res.message}`, { parse_mode: 'HTML' });
      return;
    }

    const header = res.isLatestSuccess
      ? `✅ <b>Build mới nhất của <code>${escapeHtml(targetRepo)}</code> (Run ID: <code>${res.latestRunId}</code>) đã THÀNH CÔNG!</b>\n<i>Dưới đây là log của lần lỗi cũ trước đó (Run ID: <code>${res.runId}</code> - lỗi này đã được sửa hoàn tất):</i>`
      : `<b>📜 Log lỗi gần nhất của <code>${escapeHtml(targetRepo)}</code> (Run ID: <code>${res.runId}</code>):</b>`;

    const msg = [
      header,
      `<pre>${escapeHtml(res.logs)}</pre>`
    ].join('\n\n');

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().url('🔗 Xem chi tiết trên GitHub', `https://github.com/${targetRepo}/actions/runs/${res.runId}`)
    });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi lấy log: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /site
bot.command('site', async (ctx) => {
  try {
    const { text, keyboard } = await formatSiteMessage();
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi kiểm tra site: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /server & /sys
bot.command(['server', 'sys'], async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply('⛔ <b>Từ chối truy cập:</b> Chỉ Admin mới có quyền xem thông tin máy chủ.', { parse_mode: 'HTML' });
    return;
  }
  try {
    const { text, keyboard } = await formatServerMessage();
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi đọc thông số server: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /services
bot.command('services', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply('⛔ <b>Từ chối truy cập:</b> Chỉ Admin mới có quyền xem thông tin dịch vụ.', { parse_mode: 'HTML' });
    return;
  }
  try {
    const list = await checkServices();
    const rows = list.map(s => `${s.active ? '🟢' : '🔴'} <b>${escapeHtml(s.name)}:</b> <code>${escapeHtml(s.status)}</code>`).join('\n');
    await ctx.reply(`<b>⚙️ Trạng Thái Dịch Vụ Hệ Thống:</b>\n\n${rows}`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Lỗi kiểm tra services: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /releases
bot.command('releases', async (ctx) => {
  try {
    const { text, keyboard } = await formatReleasesMessage();
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi tải releases: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// /repos
bot.command('repos', async (ctx) => {
  try {
    const repos = await listRepos('tuquet', 5);
    const lines = repos.map(r => {
      const lock = r.isPrivate ? '🔒' : '🌐';
      const date = new Date(r.pushedAt).toLocaleDateString('vi-VN');
      return `• ${lock} <a href="${escapeHtml(r.url)}">${escapeHtml(r.name)}</a> - <i>${date}</i>\n  ${escapeHtml(r.description || 'Không có mô tả')}`;
    });
    await ctx.reply(`<b>📦 Danh Sách Repositories Gần Đây:</b>\n\n${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi đọc danh sách repos: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ================= INLINE BUTTON CALLBACKS =================

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery().catch(() => {});

  if (data === 'action:ci' || data.startsWith('action:ci:')) {
    const targetRepo = data === 'action:ci' ? config.defaultRepo : data.slice('action:ci:'.length);
    const { text, keyboard } = await formatCiMessage(targetRepo);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else if (data === 'action:ci_all') {
    const { text, keyboard } = await formatMultiRepoCiMessage();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
    });
  } else if (data === 'action:server') {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Chỉ Admin mới có quyền xem thông tin server.');
      return;
    }
    const { text, keyboard } = await formatServerMessage();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else if (data === 'action:site') {
    const { text, keyboard } = await formatSiteMessage();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else if (data === 'action:deploy_confirm') {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Chỉ Admin mới có quyền kích hoạt deploy.');
      return;
    }
    const confirmKeyboard = new InlineKeyboard()
      .text('✅ Xác nhận Deploy ngay', 'action:deploy_execute')
      .row()
      .text('❌ Huỷ', 'action:help');
    await ctx.editMessageText(
      `⚠️ <b>Xác nhận Deploy Website</b>\nBạn có chắc chắn muốn kích hoạt deploy cho repo <code>${escapeHtml(config.defaultRepo)}</code> không?`,
      { parse_mode: 'HTML', reply_markup: confirmKeyboard }
    );
  } else if (data === 'action:deploy_execute') {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Chỉ Admin mới có quyền kích hoạt deploy.');
      return;
    }
    await ctx.editMessageText(`⏳ <b>Đang gửi yêu cầu deploy lên GitHub Actions...</b>`, { parse_mode: 'HTML' });
    try {
      await triggerDeploy(config.defaultRepo, config.deployWorkflow, 'main');
      await ctx.editMessageText(
        `🚀 <b>Deploy đã kích hoạt thành công!</b>\nWorkflow <code>${escapeHtml(config.deployWorkflow)}</code> đang tiến hành build. Bot sẽ gửi thông báo vào nhóm khi hoàn tất.`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('📊 Xem tiến độ CI', 'action:ci'),
        }
      );
    } catch (err) {
      await ctx.editMessageText(`❌ Lỗi khi kích hoạt deploy: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  } else if (data === 'action:logs') {
    try {
      const res = await getFailedLogs(config.defaultRepo);
      if (!res.hasFailed) {
        await ctx.reply(`✅ ${res.message}`, { parse_mode: 'HTML' });
        return;
      }

      const header = res.isLatestSuccess
        ? `✅ <b>Build mới nhất (Run ID: <code>${res.latestRunId}</code>) đã THÀNH CÔNG!</b>\n<i>Dưới đây là log của lần lỗi cũ trước đó (Run ID: <code>${res.runId}</code> - lỗi này đã được sửa hoàn tất):</i>`
        : `<b>📜 Log lỗi gần nhất (Run ID: <code>${res.runId}</code>):</b>`;

      const msg = [
        header,
        `<pre>${escapeHtml(res.logs)}</pre>`
      ].join('\n\n');

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().url('🔗 Xem chi tiết trên GitHub', `https://github.com/${config.defaultRepo}/actions/runs/${res.runId}`)
      });
    } catch (err) {
      await ctx.reply(`❌ Lỗi khi lấy log: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  } else if (data === 'action:services') {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Chỉ Admin mới có quyền xem thông tin dịch vụ.');
      return;
    }
    try {
      const list = await checkServices();
      const rows = list.map(s => `${s.active ? '🟢' : '🔴'} <b>${escapeHtml(s.name)}:</b> <code>${escapeHtml(s.status)}</code>`).join('\n');
      await ctx.reply(`<b>⚙️ Trạng Thái Dịch Vụ Hệ Thống:</b>\n\n${rows}`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Lỗi kiểm tra services: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  } else if (data === 'action:releases') {
    try {
      const { text, keyboard } = await formatReleasesMessage();
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true }).catch(async () => {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
      });
    } catch (err) {
      await ctx.reply(`❌ Lỗi khi tải releases: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  } else if (data === 'action:repos') {
    try {
      const repos = await listRepos('tuquet', 5);
      const lines = repos.map(r => {
        const lock = r.isPrivate ? '🔒' : '🌐';
        const date = new Date(r.pushedAt).toLocaleDateString('vi-VN');
        return `• ${lock} <a href="${escapeHtml(r.url)}">${escapeHtml(r.name)}</a> - <i>${date}</i>\n  ${escapeHtml(r.description || 'Không có mô tả')}`;
      });
      await ctx.reply(`<b>📦 Danh Sách Repositories Gần Đây:</b>\n\n${lines.join('\n\n')}`, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (err) {
      await ctx.reply(`❌ Lỗi khi đọc danh sách repos: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  } else if (data === 'action:help') {
    await ctx.editMessageText(
      `<b>Bảng Điều Khiển Nhanh @FlowupAI_bot</b>\nChạm vào các nút bên dưới để thực thi tác vụ:`,
      { parse_mode: 'HTML', reply_markup: getMainKeyboard() }
    ).catch(async () => {
      await ctx.reply(`<b>Bảng Điều Khiển Nhanh @FlowupAI_bot</b>`, { parse_mode: 'HTML', reply_markup: getMainKeyboard() });
    });
  }
});

// Error handling
bot.catch((err) => {
  console.error('[Bot Error]', err.error || err);
});

// Start bot
async function start() {
  await setupBotCommands();
  console.log(`[Bot] Starting @FlowupAI_bot long polling...`);
  bot.start({
    onStart: (botInfo) => {
      console.log(`[Bot] Started successfully as @${botInfo.username}`);

      // Initialize release tracker and schedule periodic checks
      checkForNewReleases(bot);
      const releaseIntervalMs = Math.max(1, config.releasePollMinutes) * 60 * 1000;
      setInterval(() => {
        checkForNewReleases(bot);
      }, releaseIntervalMs);
      console.log(`[Bot] Release monitor polling every ${config.releasePollMinutes} minute(s).`);

      // Initialize CI workflow monitor across all repositories
      checkForCiUpdates(bot);
      const ciIntervalMs = Math.max(1, config.ciPollMinutes) * 60 * 1000;
      setInterval(() => {
        checkForCiUpdates(bot);
      }, ciIntervalMs);
      console.log(`[Bot] CI monitor polling every ${config.ciPollMinutes} minute(s) across ${config.monitoredRepos.length} repos.`);

      // Initialize blog feed monitor for tuquet.github.io
      checkForNewBlogPosts(bot);
      const blogIntervalMs = 60 * 1000;
      setInterval(() => {
        checkForNewBlogPosts(bot);
      }, blogIntervalMs);
      console.log(`[Bot] Blog monitor polling every 1 minute.`);
    }
  });
}

start();
