import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const STATE_FILE = path.join(config.dataDir, 'last_release.json');

/**
 * Fetch latest releases from Netlify API or fallback to RSS Feed
 */
export async function getLatestReleases(limit = 5) {
  // Strategy 1: Try structured API
  try {
    const res = await fetch(config.releasesApiUrl, {
      headers: { 'User-Agent': 'FlowupAI-Bot/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.infos)) {
        return data.infos
          .filter(item => item.version)
          .slice(0, limit)
          .map(item => ({
            id: item.id || `release:${item.repo}@${item.version}`,
            repo: item.repo || 'unknown',
            version: item.version,
            title: item.title || `${item.repo} ${item.version}`,
            url: item.commit || `https://github.com/${item.repo}/releases/tag/v${item.version}`,
            createdAt: item.created_at ? new Date(item.created_at).toISOString() : new Date().toISOString(),
          }));
      }
    }
  } catch (err) {
    console.warn('[Releases] API fetch failed, falling back to RSS feed:', err.message);
  }

  // Strategy 2: Fallback to RSS feed XML
  try {
    const res = await fetch(config.releasesFeedUrl, {
      headers: { 'User-Agent': 'FlowupAI-Bot/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const xml = await res.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
        const itemXml = match[1];
        const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || itemXml.match(/<title>(.*?)<\/title>/);
        const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
        const guidMatch = itemXml.match(/<guid[^>]*>(.*?)<\/guid>/);
        const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/);

        const title = titleMatch ? titleMatch[1].trim() : 'New Release';
        const link = linkMatch ? linkMatch[1].trim() : config.releasesFeedUrl;
        const guid = guidMatch ? guidMatch[1].trim() : link;
        const pubDate = pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString();

        // Extract repo and version from title e.g. "tuquet/scoop-bucket v1.0.0 released"
        const parts = title.replace(/\s+released$/i, '').split(/\s+/);
        const repo = parts[0] || 'tuquet';
        const version = parts[1] || '';

        items.push({
          id: guid,
          repo,
          version,
          title,
          url: link,
          createdAt: pubDate,
        });
      }

      if (items.length > 0) {
        return items;
      }
    }
  } catch (err) {
    console.warn('[Releases] RSS feed fallback failed:', err.message);
  }

  return [];
}

/**
 * Check for new releases and broadcast announcement to target Telegram chats
 */
export async function checkForNewReleases(bot) {
  try {
    const releases = await getLatestReleases(10);
    if (!releases || releases.length === 0) return;

    // Load saved state
    let state = { lastSeenId: null, lastSeenTime: 0 };
    if (fs.existsSync(STATE_FILE)) {
      try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch (e) {
        // ignore parse error
      }
    }

    // First run initialization: record latest and return without spamming
    if (!state.lastSeenId) {
      const latest = releases[0];
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        lastSeenId: latest.id,
        lastSeenTime: new Date(latest.createdAt).getTime(),
      }, null, 2));
      console.log(`[Releases] Initialized state tracker at latest release: ${latest.id}`);
      return;
    }

    // Find new releases newer than state.lastSeenTime or differing from lastSeenId
    const newReleases = [];
    for (const rel of releases) {
      const relTime = new Date(rel.createdAt).getTime();
      if (rel.id === state.lastSeenId || relTime <= state.lastSeenTime) {
        break;
      }
      newReleases.push(rel);
    }

    if (newReleases.length === 0) {
      return;
    }

    console.log(`[Releases] Found ${newReleases.length} new release(s)! Broadcasting...`);

    // Determine target chats
    const targetChats = config.broadcastChats.length > 0 ? config.broadcastChats : config.allowedChats;

    // Broadcast newest releases (in chronological order)
    for (const rel of newReleases.reverse()) {
      const timeStr = new Date(rel.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      const msg = [
        `🎉 <b>PHÁT HÀNH MỚI: <code>${escapeHtml(rel.repo)}</code> ${escapeHtml(rel.version)}</b>`,
        ``,
        `📌 <b>Nội dung:</b> ${escapeHtml(rel.title)}`,
        `🕒 <b>Thời gian:</b> ${timeStr}`,
        ``,
        `🔗 <a href="${escapeHtml(rel.url)}">Xem chi tiết trên GitHub Release</a>`,
      ].join('\n');

      for (const chatId of targetChats) {
        try {
          await bot.api.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          });
          console.log(`[Releases] Sent announcement for ${rel.repo} to ${chatId}`);
        } catch (err) {
          console.warn(`[Releases] Failed to send announcement to ${chatId}:`, err.message);
        }
      }
    }

    // Save updated state
    const newest = releases[0];
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastSeenId: newest.id,
      lastSeenTime: new Date(newest.createdAt).getTime(),
    }, null, 2));

  } catch (err) {
    console.error('[Releases] Error checking new releases:', err.message);
  }
}

/**
 * Check for new blog posts on tuquet.github.io/feed.xml and broadcast to Telegram
 */
export async function checkForNewBlogPosts(bot) {
  const BLOG_STATE_FILE = path.join(config.dataDir, 'last_blog_post.json');
  try {
    const res = await fetch('https://tuquet.github.io/feed.xml', {
      headers: { 'User-Agent': 'FlowupAI-Bot/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;

    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const itemXml = match[1];
      const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || itemXml.match(/<title>(.*?)<\/title>/);
      const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
      const guidMatch = itemXml.match(/<guid[^>]*>(.*?)<\/guid>/);
      const descMatch = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || itemXml.match(/<description>(.*?)<\/description>/);

      const title = titleMatch ? titleMatch[1].trim() : 'Bài viết mới';
      const link = linkMatch ? linkMatch[1].trim() : 'https://tuquet.github.io/posts';
      const guid = guidMatch ? guidMatch[1].trim() : link;
      const desc = descMatch ? descMatch[1].trim() : '';

      items.push({ title, link, guid, desc });
    }

    if (items.length === 0) return;

    let state = { lastSeenGuid: null };
    if (fs.existsSync(BLOG_STATE_FILE)) {
      try {
        state = JSON.parse(fs.readFileSync(BLOG_STATE_FILE, 'utf8'));
      } catch (e) {
        state = { lastSeenGuid: null };
      }
    }

    if (!state.lastSeenGuid) {
      fs.writeFileSync(BLOG_STATE_FILE, JSON.stringify({ lastSeenGuid: items[0].guid }, null, 2));
      console.log(`[Blog Monitor] Initialized tracker at latest post: ${items[0].title}`);
      return;
    }

    const newPosts = [];
    for (const item of items) {
      if (item.guid === state.lastSeenGuid) break;
      newPosts.push(item);
    }

    if (newPosts.length === 0) return;

    console.log(`[Blog Monitor] Found ${newPosts.length} new blog post(s)! Broadcasting...`);
    const targetChats = config.broadcastChats.length > 0 ? config.broadcastChats : config.allowedChats;

    for (const post of newPosts.reverse()) {
      const msg = [
        `📝 <b>BÀI VIẾT BLOG MỚI:</b>`,
        `📌 <b>${escapeHtml(post.title)}</b>`,
        ``,
        `<i>${escapeHtml(post.desc)}</i>`,
        ``,
        `🔗 <a href="${escapeHtml(post.link)}">Đọc bài viết trên tuquet.github.io</a>`,
      ].join('\n');

      for (const chatId of targetChats) {
        await bot.api.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: false }).catch(() => {});
      }
    }

    fs.writeFileSync(BLOG_STATE_FILE, JSON.stringify({ lastSeenGuid: items[0].guid }, null, 2));
  } catch (err) {
    // ignore
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
