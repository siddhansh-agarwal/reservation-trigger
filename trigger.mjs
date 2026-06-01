#!/usr/bin/env node

const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_WORKFLOW_FILE = process.env.TARGET_WORKFLOW_FILE;
const DISPATCH_EVENT_TYPE = process.env.DISPATCH_EVENT_TYPE || 'reservation-trigger';
const TOKEN = process.env.DISPATCH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const TIMEZONE = process.env.TRIGGER_TIMEZONE || 'UTC';
const DRY_RUN = process.env.DRY_RUN === 'true';

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

const dispatchOffsetsMinutes = parseNumberList(
  process.env.DISPATCH_OFFSETS_MINUTES,
  [-75, -45, -20, -5, 2, 15, 60]
);
const horizonMs = Number(process.env.TRIGGER_HORIZON_HOURS || 7) * hourMs;
const pastGraceMs = Number(process.env.TRIGGER_PAST_GRACE_MINUTES || 90) * minuteMs;
const recentLookbackMs = Number(process.env.RECENT_LOOKBACK_MINUTES || 25) * minuteMs;
const dispatchJitterSeconds = Number(process.env.GITHUB_RUN_ID || 0) % 60;

async function main() {
  if (!TOKEN && !DRY_RUN) throw new Error('Missing DISPATCH_TOKEN.');
  if (!TARGET_REPO && !DRY_RUN) throw new Error('Missing TARGET_REPO.');
  if (!TARGET_WORKFLOW_FILE && !DRY_RUN) throw new Error('Missing TARGET_WORKFLOW_FILE.');

  const targets = loadTargets();
  const startedAt = new Date();
  console.log(`Trigger sentry started. Targets configured: ${targets.length}.`);

  const windows = upcomingWindows(startedAt, targets)
    .filter(({ opensAt }) =>
      opensAt.getTime() >= startedAt.getTime() - pastGraceMs &&
      opensAt.getTime() <= startedAt.getTime() + horizonMs
    )
    .sort((a, b) => a.opensAt - b.opensAt);

  if (!windows.length) {
    console.log('No targets are close enough for this sentry run.');
    return;
  }

  console.log(`Eligible target windows: ${windows.map((window) => window.id).join(', ')}.`);
  for (const window of windows) {
    await handleWindow(window);
  }
}

function loadTargets() {
  const raw = process.env.TRIGGER_TARGETS_JSON;
  if (!raw) throw new Error('Missing TRIGGER_TARGETS_JSON.');

  const targets = JSON.parse(raw);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('TRIGGER_TARGETS_JSON must be a non-empty array.');
  }

  return targets.map((target, index) => {
    const id = String(target.id || `target-${index + 1}`);
    if (!Number.isInteger(Number(target.openDayOfWeek))) {
      throw new Error(`${id} needs openDayOfWeek.`);
    }
    if (!/^\d{1,2}:\d{2}$/.test(String(target.openTime || ''))) {
      throw new Error(`${id} needs openTime in HH:mm format.`);
    }
    return {
      id,
      openDayOfWeek: Number(target.openDayOfWeek),
      openTime: String(target.openTime)
    };
  });
}

async function handleWindow(window) {
  console.log(`Target ${window.id} is inside the sentry horizon.`);

  for (const offset of dispatchOffsetsMinutes) {
    const dispatchAt = new Date(window.opensAt.getTime() + offset * minuteMs);
    const now = new Date();
    if (dispatchAt.getTime() < now.getTime() - 2 * minuteMs) continue;
    if (dispatchAt.getTime() > window.opensAt.getTime() + 65 * minuteMs) continue;

    await sleepUntil(dispatchAt, `target ${window.id} offset ${offset}m`);
    await sleepJitter();
    const recent = await hasActiveOrRecentMainRun();
    if (recent) {
      console.log(`Skipping dispatch for target ${window.id}; target repository is active or recently ran.`);
      continue;
    }

    await dispatchTarget(window, offset);
  }
}

async function sleepJitter() {
  if (dispatchJitterSeconds <= 0) return;
  if (DRY_RUN) {
    console.log(`DRY_RUN: would wait ${dispatchJitterSeconds}s dispatch jitter.`);
    return;
  }
  console.log(`Waiting ${dispatchJitterSeconds}s dispatch jitter.`);
  await sleep(dispatchJitterSeconds * 1000);
}

async function hasActiveOrRecentMainRun() {
  if (DRY_RUN) {
    console.log('DRY_RUN: would check for active/recent target runs.');
    return false;
  }

  const since = new Date(Date.now() - recentLookbackMs).toISOString();
  const url = `https://api.github.com/repos/${TARGET_REPO}/actions/workflows/${encodeURIComponent(TARGET_WORKFLOW_FILE)}/runs?per_page=30`;
  const data = await githubJson(url);
  const recent = data.workflow_runs?.filter((run) =>
    run.status !== 'completed' || run.created_at >= since
  ) || [];
  if (recent.length) {
    console.log(`Found ${recent.length} active/recent target run(s).`);
    return true;
  }
  console.log('No active/recent target runs found.');
  return false;
}

async function dispatchTarget(window, offsetMinutes) {
  if (DRY_RUN) {
    console.log(`DRY_RUN: would dispatch target ${window.id} at offset ${offsetMinutes}m.`);
    return;
  }

  const url = `https://api.github.com/repos/${TARGET_REPO}/dispatches`;
  const payload = {
    event_type: DISPATCH_EVENT_TYPE,
    client_payload: {
      watch: true,
      source: 'generic-trigger',
      targetId: window.id,
      offsetMinutes
    }
  };

  await githubJson(url, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  console.log(`Dispatched target ${window.id} at offset ${offsetMinutes}m.`);
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      ...options.headers
    }
  });

  if (response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function sleepUntil(date, label) {
  if (DRY_RUN) {
    console.log(`DRY_RUN: would wait for ${label}.`);
    return;
  }

  while (Date.now() < date.getTime()) {
    const remainingMs = date.getTime() - Date.now();
    const waitMs = Math.min(5 * minuteMs, remainingMs);
    console.log(`Waiting ${Math.ceil(remainingMs / minuteMs)}m for ${label}.`);
    await sleep(waitMs);
  }
}

function upcomingWindows(now, targets) {
  const local = zonedParts(now);
  const todayLocalMidnight = zonedDateToUtc({
    year: local.year,
    month: local.month,
    day: local.day,
    hour: 0,
    minute: 0,
    second: 0
  });

  const windows = [];
  for (const target of targets) {
    const [hour, minute] = target.openTime.split(':').map(Number);
    for (let offset = -1; offset <= 3; offset += 1) {
      const localDay = new Date(todayLocalMidnight.getTime() + offset * dayMs);
      const parts = zonedParts(localDay);
      if (parts.weekday !== target.openDayOfWeek) continue;
      const opensAt = zonedDateToUtc({
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour,
        minute,
        second: 0
      });
      windows.push({ ...target, opensAt });
    }
  }
  return windows;
}

function zonedParts(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function zonedDateToUtc({ year, month, day, hour, minute, second }) {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(guess);
    const delta = Date.UTC(year, month - 1, day, hour, minute, second || 0) -
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess = new Date(guess.getTime() + delta);
  }
  return guess;
}

function parseNumberList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((item) => Number(item.trim())).filter(Number.isFinite);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
