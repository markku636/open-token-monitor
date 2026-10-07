'use strict';

// Synthetic device uploads in the wire shape the agent and widget post
// (docs/API.md), so tests exercise upstream's own normalization on the way in.
// No real hostnames, accounts or usage: never copy data/devices.json in here.

const { upstream } = require('../../upstream');
const { mergeDeviceRecord } = require(upstream('src/shared/usage'));

function dayKey(offsetDays = 0, from = Date.now()) {
  return new Date(from + offsetDays * 86400000).toISOString().slice(0, 10);
}

function monthOf(day) {
  return day.slice(0, 7);
}

function nextDayIso(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString();
}

function nextMonthIso(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString();
}

function session(client, id, { tokens = 500, cost = 0.25, projectLabel = 'alpha-service', model = 'claude-sonnet-4-5' } = {}) {
  return {
    client,
    sessionId: id,
    totalTokens: tokens,
    costUsd: cost,
    messageCount: 4,
    inputTokens: Math.round(tokens * 0.2),
    outputTokens: Math.round(tokens * 0.05),
    cacheReadTokens: Math.round(tokens * 0.7),
    cacheWriteTokens: Math.round(tokens * 0.05),
    reasoningTokens: 0,
    startedAt: '2026-09-20T01:00:00.000Z',
    lastUsedAt: '2026-09-20T02:00:00.000Z',
    projectId: 'sha256:project-alpha',
    projectLabel,
    title: 'must never be stored',
    models: { [model]: tokens },
    modelCosts: { [model]: cost },
    providers: { anthropic: tokens }
  };
}

function period({ tokens = 1000, cost = 0.5, client = 'claude', model = 'claude-sonnet-4-5', sessions } = {}) {
  const part = (ratio) => Math.round(tokens * ratio);
  return {
    capabilities: { tokenComponents: true, throughput: true },
    totalTokens: tokens,
    costUsd: cost,
    cacheReadTokens: part(0.6),
    cacheWriteTokens: part(0.1),
    outputTokens: part(0.05),
    unclassifiedTokens: 0,
    clients: { [client]: tokens },
    clientCosts: { [client]: cost },
    clientCacheReads: { [client]: part(0.6) },
    clientCacheWrites: { [client]: part(0.1) },
    clientOutputs: { [client]: part(0.05) },
    models: { [model]: tokens },
    modelCosts: { [model]: cost },
    modelCacheReads: { [model]: part(0.6) },
    modelCacheWrites: { [model]: part(0.1) },
    modelOutputs: { [model]: part(0.05) },
    clientModels: { [client]: { [model]: tokens } },
    clientModelCosts: { [client]: { [model]: cost } },
    sessions: sessions || { [`${client}:s-1`]: session(client, 's-1', { tokens, cost }) }
  };
}

function historyDay(date, { tokens = 800, cost = 0.4, client = 'claude', model = 'claude-sonnet-4-5' } = {}) {
  return {
    date,
    tokens,
    cost,
    messages: 6,
    cacheReadTokens: Math.round(tokens * 0.6),
    cacheWriteTokens: Math.round(tokens * 0.1),
    outputTokens: Math.round(tokens * 0.05),
    unclassifiedTokens: 0,
    tokenComponentsAvailable: true,
    activeTimeMs: 60000,
    perClient: { [client]: { tokens, cost, messages: 6, unclassifiedTokens: 0, cacheReadTokens: Math.round(tokens * 0.6), cacheWriteTokens: Math.round(tokens * 0.1), outputTokens: Math.round(tokens * 0.05) } },
    perModel: { [model]: { tokens, cost, unclassifiedTokens: 0, cacheReadTokens: Math.round(tokens * 0.6), cacheWriteTokens: Math.round(tokens * 0.1), outputTokens: Math.round(tokens * 0.05) } }
  };
}

function historyMonth(month, { tokens = 5000, cost = 2.5, client = 'claude', model = 'claude-sonnet-4-5' } = {}) {
  return {
    month,
    tokens,
    cost,
    activeTimeMs: 600000,
    perClient: { [client]: { tokens, cost, messages: 30, unclassifiedTokens: 0 } },
    perModel: { [model]: { tokens, cost, unclassifiedTokens: 0 } }
  };
}

function provider({ provider: id = 'claude', email = 'someone@example.test', plan = 'Max' } = {}) {
  return {
    provider: id,
    accountKey: `sha256:${id}-${email}`,
    accountEmail: email,
    planLabel: plan,
    status: 'ok',
    source: 'oauth',
    updatedAt: '2026-09-20T02:00:00.000Z',
    windows: [{ kind: 'session', usedPercent: 40, remainingPercent: 60, resetsAt: '2026-09-20T05:00:00.000Z' }]
  };
}

// One upload. `day` is the device-local day its today period belongs to.
function devicePayload({
  deviceId = 'dev-a',
  hostname = 'host-a',
  day = dayKey(0),
  tokens = 1000,
  cost = 0.5,
  monthTokens = 4000,
  monthCost = 2,
  history,
  limits = true,
  updatedAt = new Date().toISOString(),
  agentVersion = '0.61.0-corp.1',
  platform = 'win32',
  extra = {}
} = {}) {
  const month = monthOf(day);
  const payload = {
    deviceId,
    hostname,
    platform,
    agentVersion,
    agentRuntime: 'electron-widget',
    updatedAt,
    syncUploadIntervalMs: 600000,
    projectsEnabled: true,
    today: period({ tokens, cost }),
    month: period({ tokens: monthTokens, cost: monthCost }),
    allTime: { totalTokens: monthTokens * 3, costUsd: monthCost * 3 },
    periodWindows: {
      timeZone: 'Asia/Taipei',
      today: { key: day, endsAt: nextDayIso(day) },
      month: { key: month, endsAt: nextMonthIso(month) }
    },
    ...extra
  };
  if (history !== undefined) {
    payload.historyAvailable = history !== null;
    payload.history = history;
  }
  if (limits) payload.limits = { updatedAt: '2026-09-20T02:00:00.000Z', refreshMs: 300000, providers: [provider()] };
  return payload;
}

// What upstream's hub.ingest() would store for `payload` on top of `existing`.
function merged(payload, existing, receivedAt = new Date().toISOString()) {
  return mergeDeviceRecord(existing, { ...payload, receivedAt });
}

module.exports = { dayKey, devicePayload, historyDay, historyMonth, merged, monthOf, period, provider, session };
