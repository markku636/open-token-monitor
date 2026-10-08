'use strict';

// The reports API v1 (reports.js, analytics.js) as an OpenAPI 3.1 document,
// served at /api/reports/v1/openapi.json (apiDocs.js) for Postman, Bruno and
// client generators. It describes the same contract as /llms-full.txt and
// docs/reports-api.zh-TW.md; tests/apiDocs.test.js checks that all three name
// every route, and that the answers carry the fields named here.

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const string = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const integer = (description) => ({ type: 'integer', ...(description ? { description } : {}) });
const number = (description) => ({ type: 'number', ...(description ? { description } : {}) });
const boolean = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const day = (description) => string(description, { format: 'date' });
const instant = (description) => nullable('string', { format: 'date-time', ...(description ? { description } : {}) });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const list = (items) => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', required, properties });

const LEVELS = ['company', 'bu', 'department', 'team'];
const GROUPS = [...LEVELS, 'unit', 'employee', 'client', 'model', 'device'];

const param = (name, description, schema = { type: 'string' }, extra = {}) => ({ name, in: 'query', required: false, description, schema, ...extra });

const PARAMETERS = {
  format: param('format', 'csv for CSV (UTF-8 with a BOM, so Excel opens it); the same as sending Accept: text/csv. JSON otherwise.', { type: 'string', enum: ['json', 'csv'] }),
  groupBy: param('groupBy', 'What each row is: an org level (each day charged to the unit the device\'s owner had that day, rolled up to that level), unit (that unit itself), or employee, client, model, device. Default department.', { type: 'string', enum: GROUPS, default: 'department' }),
  unitId: param('unitId', 'Only this unit and every unit under it (GET /api/reports/v1/units lists them).'),
  employeeId: param('employeeId', 'Only this employee (the HR employee no.).'),
  deviceId: param('deviceId', 'Only this device.'),
  from: param('from', 'First day, YYYY-MM-DD, inclusive.', { type: 'string', format: 'date' }),
  to: param('to', 'Last day, YYYY-MM-DD, inclusive.', { type: 'string', format: 'date' }),
  active: param('active', 'true: only active ones; false: only inactive ones. Both by default.', { type: 'string', enum: ['true', 'false'] })
};

const ERROR = object({ error: string('A stable code, e.g. bad_range'), message: string('What was wrong, for people') }, ['error']);

const response = (description, schema, csv = false) => ({
  description,
  content: {
    'application/json': { schema },
    ...(csv ? { 'text/csv': { schema: { type: 'string' } } } : {})
  }
});
const errorResponse = (description) => response(description, ref('Error'));

const RESPONSES = {
  BadRequest: errorResponse('A parameter is wrong; `error` says which (e.g. bad_month, bad_range, range_too_long, bad_group).'),
  Unauthorized: errorResponse('No token, a wrong one, or one revoked or expired (`unauthorized`).'),
  Forbidden: errorResponse('The token lacks the scope this route needs (`forbidden`).'),
  NotFound: errorResponse('unitId names no unit (`unknown_unit`); in usage/analysis also employeeId no employee (`unknown_employee`).'),
  Unavailable: {
    ...errorResponse('The hub runs without a database (`store_unavailable`). usage/analysis also: the hub is busy with other analyses (`usage_busy`, wait Retry-After seconds) or a statement took longer than 15 s (`usage_slow`: ask for a shorter range or a smaller unit).'),
    headers: { 'Retry-After': { description: 'usage_busy only: seconds to wait', schema: { type: 'integer' } } }
  }
};

const errors = (codes = ['400', '401', '403', '503']) => Object.fromEntries(codes.map((code) => [code, { $ref: `#/components/responses/${{
  400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 503: 'Unavailable'
}[code]}` }]));

const COST = {
  currency: string('Always USD', { enum: ['USD'] }),
  costBasis: string('Always api-list-price-equivalent: the tokens priced at each vendor\'s API list prices, not an invoice. Subscription plans (Claude Max, ChatGPT Plus…) are paid as a monthly fee.', { enum: ['api-list-price-equivalent'] }),
  generatedAt: string('When the answer was made', { format: 'date-time' })
};

const SCHEMAS = {
  Error: ERROR,
  Totals: object({ tokens: integer(), costUsd: number() }),
  UsageRow: object({
    date: day('usage/daily only: the device-local day'),
    week: day('usage/weekly only: the Monday of the ISO week'),
    key: nullable('string', { description: 'The unit, employee no., device, tool or model id; null for the "other" row' }),
    label: string('Its name; 其他 for the "other" row'),
    email: nullable('string', { description: 'groupBy=employee only' }),
    path: nullable('string', { description: 'Org groupings (and unit) only: the names from the company down, joined by /' }),
    costCenter: nullable('string', { description: 'Org groupings (and unit) only' }),
    other: boolean('true for the one row of usage in no unit of the level asked for, or with no owner. It comes last.'),
    tokens: integer(),
    costUsd: number(),
    devices: integer('Devices with usage in this row; a device that changed units in the period counts in each of its rows')
  }, ['key', 'label', 'other', 'tokens', 'costUsd', 'devices']),
  MonthlyReport: object({ ok: boolean(), month: string('YYYY-MM'), groupBy: string(), ...COST, totals: ref('Totals'), rows: list(ref('UsageRow')) }),
  RangeReport: object({ ok: boolean(), from: day(), to: day(), groupBy: string(), ...COST, totals: ref('Totals'), rows: list(ref('UsageRow')) }),
  Device: object({
    deviceId: string(), hostname: string(), platform: string(), osName: nullable('string'), osVersion: nullable('string'),
    agentVersion: string(), agentRuntime: string(), lastSeenAt: instant('The last upload'), firstSeenAt: instant(),
    employeeId: nullable('string'), employeeName: nullable('string'), employeeEmail: nullable('string'),
    unitId: nullable('string'), unitName: nullable('string'), costCenter: nullable('string')
  }),
  Account: object({
    provider: string('e.g. claude, codex'), accountEmail: nullable('string'), accountName: nullable('string'), accountLabel: nullable('string'),
    planLabel: nullable('string'), status: nullable('string'), updatedAt: instant(),
    deviceId: string(), hostname: string(), employeeId: nullable('string'), employeeName: nullable('string'),
    unitId: nullable('string'), unitName: nullable('string')
  }),
  Unit: object({
    unitId: string('The path of names, e.g. ACME/Games/RND'),
    name: string(),
    level: string(undefined, { enum: LEVELS }),
    parentUnitId: nullable('string'),
    path: string('The names from the company down, joined by /'),
    costCenter: nullable('string'),
    active: boolean('false once the latest HR list no longer has it; ownership history may still point at it'),
    headcount: integer('Active employees in it and every unit under it'),
    ownHeadcount: integer('Active employees placed in it directly'),
    devices: integer('Devices charged to it and every unit under it today'),
    tokensLast30Days: integer('It and every unit under it, as each day was charged'),
    costUsdLast30Days: number()
  }),
  Employee: object({
    employeeId: string('The HR employee no.'),
    name: nullable('string', { description: 'The English name (never the Chinese one); the part of the email before the @ when there is none' }),
    email: nullable('string', { description: 'Lower-case' }),
    active: boolean('On the latest HR list of their company'),
    companyId: nullable('string'),
    unitId: nullable('string', { description: 'Where the latest HR list placed them' }),
    path: nullable('string'),
    effectiveFrom: nullable('string', { format: 'date', description: 'When that placement took effect' }),
    devices: integer('Devices charged to them today'),
    tokensLast30Days: integer(),
    costUsdLast30Days: number(),
    updatedAt: instant()
  }),
  LimitWindow: object({
    kind: string('session (e.g. a 5-hour window), daily, weekly or billing', { enum: ['session', 'daily', 'weekly', 'billing'] }),
    label: nullable('string', { description: 'As the provider names it, e.g. 5-hour' }),
    metric: nullable('string'),
    usedPercent: nullable('number', { description: '0–100' }),
    remainingPercent: nullable('number'),
    used: nullable('number'),
    limit: nullable('number'),
    remaining: nullable('number'),
    currency: nullable('string'),
    resetsAt: instant(),
    windowMinutes: nullable('number')
  }),
  LimitAccount: object({
    provider: string(), accountEmail: nullable('string'), accountName: nullable('string'), accountLabel: nullable('string'),
    planLabel: nullable('string'), workspaceKind: nullable('string'), status: nullable('string', { description: 'ok, unauthorized, rateLimited, sourceRateLimited, unavailable or error' }), source: nullable('string', { description: 'oauth, cli, web, rpc, local or api' }),
    balanceUsd: nullable('number', { description: 'Prepaid credit left, when the provider reports one' }),
    windows: list(ref('LimitWindow')),
    updatedAt: instant('When the provider last answered'),
    receivedAt: instant('When the device last uploaded it'),
    deviceId: string(), hostname: string(), employeeId: nullable('string'), employeeName: nullable('string', { description: 'English name only' }),
    unitId: nullable('string'), unitName: nullable('string')
  }),
  Period: object({ period: string('Its key: YYYY-MM-DD for a day or for a week (its Monday), YYYY-MM for a month, range for focus=range'), from: day(), to: day(), days: integer() }),
  Figures: object({
    tokens: integer(),
    costUsd: number(),
    devices: integer('Devices with usage'),
    employees: integer('Employees with usage (units and totals only)'),
    activeDays: integer('Days with usage (people, devices and totals only)'),
    unownedDevices: integer('focusTotals only: devices whose usage in the focus nobody is charged with')
  }, ['tokens', 'costUsd']),
  TrendRow: object({ period: string(), tokens: integer(), costUsd: number(), devices: integer(), employees: integer() }, ['period', 'tokens', 'costUsd']),
  UnitRef: nullable('object', { required: ['unitId', 'name', 'path'], properties: { unitId: string(), name: string(), path: string() } }),
  ToolFigures: object({ client: string(), focus: ref('Figures'), comparison: ref('Figures') }),
  KeyedUsage: object({
    model: string('models only'),
    client: string('clients only'),
    focus: ref('Figures'),
    comparison: ref('Figures'),
    trend: list(ref('TrendRow'))
  }, ['focus', 'comparison', 'trend']),
  AnalysisUnit: object({
    unitId: string(), name: string(), path: string(), active: boolean(), headcount: integer(),
    focus: ref('Figures'), comparison: ref('Figures'), trend: list(ref('TrendRow')),
    clients: { ...list(ref('ToolFigures')), description: 'Its usage by tool; not with client=' }
  }, ['unitId', 'name', 'path', 'active', 'headcount', 'focus', 'comparison', 'trend']),
  AnalysisEmployee: object({
    employeeId: nullable('string', { description: 'null for the one "other" row: usage no employee is charged with' }),
    name: nullable('string'), email: nullable('string'), other: boolean(), unit: ref('UnitRef'),
    focus: ref('Figures'), comparison: ref('Figures'), trend: list(ref('TrendRow')),
    clients: list(ref('ToolFigures'))
  }, ['employeeId', 'name', 'email', 'other', 'unit', 'focus', 'comparison', 'trend']),
  AnalysisDevice: object({
    deviceId: string(), hostname: nullable('string'), deleted: boolean(), focus: ref('Figures'), comparison: ref('Figures'),
    trend: { ...list(ref('TrendRow')), description: 'One person\'s view only' }
  }, ['deviceId', 'hostname', 'deleted', 'focus', 'comparison']),
  AnalysisAccount: object({
    account: nullable('string', { description: 'The AI account (email, else name); several joined by " + " when a device holds more than one for the provider; null for usage on a device with no account for the tool\'s provider' }),
    holders: list(string()), shared: boolean(), other: boolean(), providers: list(string()), unit: ref('UnitRef'),
    devices: list(object({ deviceId: string(), hostname: nullable('string') })),
    tools: list(object({ client: string(), tokens: integer(), costUsd: number() })),
    focus: ref('Figures'), comparison: ref('Figures')
  }),
  Analysis: object({
    ok: boolean(),
    ...COST,
    from: day(), to: day(),
    granularity: string(undefined, { enum: ['day', 'week', 'month'] }),
    periods: { ...list(ref('Period')), description: 'The range cut into days, ISO weeks or months; the first and last may be clipped' },
    focus: { ...ref('Period'), description: 'The period the figures are about: the last one (focus=last) or the whole range (focus=range)' },
    comparison: object({ mode: string(undefined, { enum: ['previous', 'year', 'custom'] }), from: day(), to: day(), days: integer(), partial: boolean('Not a whole period') }),
    scope: nullable('object', { description: 'The unit asked for; null for every company', properties: { unitId: string(), name: string(), level: string(), path: string() } }),
    employee: nullable('object', { description: 'employeeId= only: who', properties: { employeeId: string(), name: nullable('string'), email: nullable('string'), active: boolean(), unit: ref('UnitRef') } }),
    client: nullable('string', { description: 'The tool asked for with client=' }),
    level: nullable('string', { description: 'The level `units` are of' }),
    levels: list(string()),
    headcount: integer('Active employees on the HR lists in the scope'),
    dataFrom: object({ daily: nullable('string', { format: 'date' }), monthly: nullable('string', { description: 'YYYY-MM' }) }),
    collectingFrom: nullable('string', { format: 'date', description: 'The day the hub first saw a device: before it, only history devices uploaded' }),
    purgedBefore: nullable('string', { format: 'date', description: 'An admin deleted every usage before this day' }),
    monthlyFallback: { ...list(string()), description: 'Months (YYYY-MM) of a month view counted from month totals' },
    totals: { ...ref('Figures'), description: 'The whole range' },
    focusTotals: { ...ref('Figures'), description: 'The focus; unownedDevices: devices whose usage nobody is charged with' },
    comparisonTotals: { ...ref('Figures'), description: 'The comparison window' },
    trend: list(ref('TrendRow')),
    units: { ...list(ref('AnalysisUnit')), description: 'Each unit of `level` in the scope; empty in one person\'s view' },
    other: nullable('object', { description: 'What in the scope is in no unit of `level`', properties: { focus: ref('Figures'), comparison: ref('Figures'), trend: list(ref('TrendRow')), clients: list(ref('ToolFigures')) } }),
    models: { ...list(ref('KeyedUsage')), description: 'By model: those used in the focus first, then those used only elsewhere in the range or the comparison window. Empty with client=' },
    clients: { ...list(ref('KeyedUsage')), description: 'By tool, the same way' },
    composition: object({ total: integer(), covered: integer('Tokens whose split is known'), input: integer(), output: integer(), cacheRead: integer(), cacheWrite: integer(), unclassified: integer() }),
    employees: list(ref('AnalysisEmployee')),
    unownedDevices: { ...list(ref('AnalysisDevice')), description: 'Scope view only: devices with usage nobody is charged with' },
    devices: { ...list(ref('AnalysisDevice')), description: 'One person\'s view only: their devices' },
    accounts: { ...list(ref('AnalysisAccount')), description: 'Each AI account\'s usage; empty in one person\'s view' },
    active: nullable('object', {
      description: 'The employees and devices with usage in the focus; null in one person\'s view',
      properties: {
        employees: list(object({ employeeId: nullable('string'), name: nullable('string'), unit: ref('UnitRef'), focus: ref('Figures') })),
        devices: list(object({ deviceId: string(), hostname: nullable('string'), deleted: boolean(), employee: nullable('object', { properties: { employeeId: nullable('string'), name: nullable('string') } }), unit: ref('UnitRef'), focus: ref('Figures') }))
      }
    })
  }, ['ok', 'currency', 'costBasis', 'generatedAt', 'from', 'to', 'granularity', 'periods', 'focus', 'comparison', 'totals', 'focusTotals', 'comparisonTotals', 'trend', 'units', 'models', 'clients', 'employees', 'accounts'])
};

const REPORTS = ['reports:read'];
const ANALYTICS = ['analytics:read'];
const p = (name) => ({ $ref: `#/components/parameters/${name}` });

const operation = ({ id, summary, description, scope, parameters = [], schema, csv = true, validates = true, extraErrors = [] }) => ({
  get: {
    operationId: id,
    summary,
    description,
    tags: [scope === REPORTS ? 'reports' : 'analytics'],
    security: [{ bearerAuth: scope }],
    'x-required-scope': scope[0],
    parameters,
    responses: { 200: response('OK', schema, csv), ...errors([...(validates ? ['400'] : []), '401', '403', ...extraErrors, '503']) }
  }
});

const ORG_FILTERS = [p('groupBy'), p('unitId'), p('employeeId'), p('deviceId'), p('format')];

const PATHS = {
  '/api/reports/v1/usage/monthly': operation({
    id: 'getMonthlyUsage',
    summary: 'Usage of one month, grouped',
    description: 'Summed from daily rows, each day charged to whoever owned the device that day; a month older than the hub\'s daily history falls back to month totals, charged to the owner on the 1st.',
    scope: REPORTS,
    parameters: [param('month', 'YYYY-MM; this month (UTC) by default.', { type: 'string', pattern: '^\\d{4}-\\d{2}$' }), ...ORG_FILTERS],
    schema: ref('MonthlyReport'),
    extraErrors: ['404']
  }),
  '/api/reports/v1/usage/daily': operation({
    id: 'getDailyUsage',
    summary: 'Usage per day, grouped',
    description: 'One row per day and group. Default: the last 30 days. At most 400 days per request.',
    scope: REPORTS,
    parameters: [p('from'), p('to'), ...ORG_FILTERS],
    schema: ref('RangeReport'),
    extraErrors: ['404']
  }),
  '/api/reports/v1/usage/weekly': operation({
    id: 'getWeeklyUsage',
    summary: 'Usage per ISO week, grouped',
    description: 'The range grows to whole ISO weeks (Monday–Sunday); `from` and `to` in the answer are the grown ones. Default: the last 12 weeks. At most 400 days.',
    scope: REPORTS,
    parameters: [p('from'), p('to'), ...ORG_FILTERS],
    schema: ref('RangeReport'),
    extraErrors: ['404']
  }),
  '/api/reports/v1/devices': operation({
    id: 'listDevices',
    summary: 'Every device and who it belongs to today',
    scope: REPORTS,
    parameters: [p('format')],
    validates: false,
    schema: object({ ok: boolean(), generatedAt: COST.generatedAt, devices: list(ref('Device')) })
  }),
  '/api/reports/v1/accounts': operation({
    id: 'listAccounts',
    summary: 'The AI accounts and plans each device reported',
    description: 'For reconciling with the licence list. GET /api/reports/v1/limits has their quota windows.',
    scope: REPORTS,
    parameters: [p('format')],
    validates: false,
    schema: object({ ok: boolean(), generatedAt: COST.generatedAt, accounts: list(ref('Account')) })
  }),
  '/api/reports/v1/units': operation({
    id: 'listUnits',
    summary: 'The org tree: company → BU → department → team',
    description: 'Every unit, inactive ones too unless active= says otherwise.',
    scope: ANALYTICS,
    parameters: [p('active'), p('format')],
    schema: object({ ok: boolean(), generatedAt: COST.generatedAt, units: list(ref('Unit')) })
  }),
  '/api/reports/v1/employees': operation({
    id: 'listEmployees',
    summary: 'The employees of the HR lists',
    description: 'Everyone the HR lists ever had, with where they sit, their devices today and their last 30 days.',
    scope: ANALYTICS,
    parameters: [p('unitId'), p('active'), p('format')],
    schema: object({ ok: boolean(), generatedAt: COST.generatedAt, employees: list(ref('Employee')) }),
    extraErrors: ['404']
  }),
  '/api/reports/v1/limits': operation({
    id: 'listLimits',
    summary: 'Each AI account\'s quota windows',
    description: 'One entry per device and account, as the device last reported it: plan, status, prepaid balance and every quota window (how much of it is used, when it resets). Providers not set up on a device (notConfigured, disabled) are left out. CSV has one line per window.',
    scope: ANALYTICS,
    parameters: [param('provider', 'Only this provider, e.g. claude.'), p('deviceId'), p('employeeId'), p('unitId'), p('format')],
    schema: object({ ok: boolean(), generatedAt: COST.generatedAt, accounts: list(ref('LimitAccount')) }),
    extraErrors: ['404']
  }),
  '/api/reports/v1/usage/analysis': operation({
    id: 'getUsageAnalysis',
    summary: 'Trend and comparison of a unit, or of one person',
    description: 'What the dashboard shows: the range cut into periods, the focus (the last period, or the whole range) set against a comparison window, with the scope\'s units of one level, "other", models, tools, the token kinds, people, devices and AI accounts. JSON only. At most 400 days, and the comparison window too. When the hub is busy the answer is 503 usage_busy with Retry-After; a statement past 15 s is 503 usage_slow.',
    scope: ANALYTICS,
    csv: false,
    parameters: [
      param('from', 'First day, YYYY-MM-DD. Default: 6 days before to.', { type: 'string', format: 'date' }),
      param('to', 'Last day, YYYY-MM-DD. Default: today (UTC).', { type: 'string', format: 'date' }),
      param('granularity', 'How the range is cut.', { type: 'string', enum: ['day', 'week', 'month'], default: 'day' }),
      param('focus', 'last: the last period against the same stretch of the one before; range: the whole range against the same number of days right before it.', { type: 'string', enum: ['last', 'range'], default: 'last' }),
      param('compare', 'previous (the default, as focus describes), year (a year back: 52 weeks for days and weeks, the same dates for months and ranges) or custom (compareFrom–compareTo).', { type: 'string', enum: ['previous', 'year', 'custom'], default: 'previous' }),
      param('compareFrom', 'compare=custom: first day of the comparison window. It must end by today and share no day with the focus.', { type: 'string', format: 'date' }),
      param('compareTo', 'compare=custom: last day of the comparison window.', { type: 'string', format: 'date' }),
      param('unitId', 'The scope: this unit and everything under it. Every company by default.'),
      param('level', 'The level of the units to compare, below the scope. Default: company or department, the first below it with a unit; bu and team only when asked for.', { type: 'string', enum: LEVELS }),
      param('employeeId', 'One person\'s view: their usage wherever it was charged. unitId and level are then ignored.'),
      param('client', 'Only this tool, e.g. claude or codex.')
    ],
    schema: ref('Analysis'),
    extraErrors: ['404']
  })
};

// origin: the hub as the caller reached it (apiDocs.js), for `servers`.
function openApiDocument({ origin = null } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Token Monitor hub — reports API',
      version: '1',
      summary: 'AI coding-tool token usage and equivalent cost by company, BU, department, team, employee, device, tool and model.',
      description: [
        'Read-only. Authenticate with `Authorization: Bearer <API token>` (tmk_<8 hex>_<40 hex>), made by a hub admin on the dashboard, one per system.',
        'Each route needs one scope: reports:read (usage reports, devices, accounts) or analytics:read (units, employees, limits, usage analysis). A token without it gets 403.',
        'Money is USD at API list prices (costBasis api-list-price-equivalent), not an invoice. Days are the device\'s local days.',
        'Incompatible changes go to /api/reports/v2/; v1 only ever gains fields. Prose reference: /llms-full.txt.'
      ].join('\n\n')
    },
    servers: [{ url: origin || '/', description: 'This hub' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'reports', description: 'Scope reports:read' },
      { name: 'analytics', description: 'Scope analytics:read' }
    ],
    paths: PATHS,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'tmk_<8 hex>_<40 hex>', description: 'An API token from the hub\'s dashboard (API token section).' }
      },
      parameters: PARAMETERS,
      responses: RESPONSES,
      schemas: SCHEMAS
    }
  };
}

module.exports = { openApiDocument };
