import privacyPolicyJson from "../privacy-policy.json";

type PrivacyPolicy = {
  effective_date: string;
  policy: string;
};

const privacyPolicy = privacyPolicyJson as PrivacyPolicy;

interface Env {
  REVENUECAT_BASE_URL?: string;
  REVENUECAT_ENDPOINT_PATH?: string;
  DEFAULT_METRIC?: string;
  DEFAULT_SCOPE?: string;
  DEFAULT_LABEL?: string;
  DEFAULT_SUFFIX?: string;
  DEFAULT_ICON?: string;
  DEFAULT_PRECISION?: string;
  // Time-series defaults removed; not used in overview.
}

type MetricValue = {
  value: number;
  label?: string;
};

type GoalData = {
  start: number;
  current: number;
  end: number;
  unit: string;
};

type Frame =
  | { text: string; icon: string }
  | { icon: string; goalData: GoalData };

type RevenueCatResponse = Record<string, unknown> & {
  data?: Array<Record<string, unknown>>;
  metrics?: Array<Record<string, unknown>>;
  value?: number;
  total?: number;
  current?: number;
};

type MetricScope = "overview";

const DEFAULT_BASE_URL = "https://api.revenuecat.com/v2/";
const DEFAULT_SCOPE: MetricScope = "overview";
const OVERVIEW_BUNDLE_METRIC = "overview_bundle";

type GoalParameters = {
  mrrGoal?: number;
  subscribersGoal?: number;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const requestUrl = new URL(request.url);

      if (
        requestUrl.pathname === "/privacy" ||
        requestUrl.pathname === "/privacy-policy"
      ) {
        return new Response(JSON.stringify(privacyPolicy), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }

      const revenuecatToken = extractBearerToken(
        request.headers.get("Authorization"),
      );

      if (!revenuecatToken) {
        return jsonError(
          "Authorization header with Bearer token is required",
          401,
        );
      }
      const metric =
        requestUrl.searchParams.get("metric") ??
        env.DEFAULT_METRIC ??
        OVERVIEW_BUNDLE_METRIC;

      if (!metric) {
        return jsonError("Metric is required", 400);
      }

      const projectId = requestUrl.searchParams.get("project");

      if (!projectId) {
        return jsonError("Query parameter 'project' is required", 400);
      }

      const scope = resolveScope(requestUrl, env);

      const rcUrl = buildRevenueCatUrl(
        metric,
        requestUrl,
        env,
        projectId,
        scope,
      );

      const rcResponse = await fetch(rcUrl, {
        headers: {
          Authorization: `Bearer ${revenuecatToken}`,
          Accept: "application/json",
        },
      });

      if (!rcResponse.ok) {
        return jsonError(
          `RevenueCat responded with ${rcResponse.status} ${rcResponse.statusText}`,
          rcResponse.status,
        );
      }

      const payload = (await rcResponse.json()) as RevenueCatResponse;
      const goalParams = parseGoalParams(requestUrl);
      let frames: Frame[] = [];

      if (isOverviewBundle(metric, scope)) {
        frames = buildOverviewBundleFrames(
          payload,
          requestUrl,
          env,
          goalParams,
        );
      } else {
        const metricValue = extractMetricValue(payload, scope, metric);
        if (!metricValue) {
          return jsonError("No numeric data found in RevenueCat response", 502);
        }

        frames = buildSingleMetricFrames(
          metricValue,
          metric,
          requestUrl,
          env,
          goalParams,
        );
      }

      if (frames.length === 0) {
        return jsonError("No numeric data found in RevenueCat response", 502);
      }

      return new Response(JSON.stringify({ frames }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=30",
        },
      });
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unexpected error occurred",
        500,
      );
    }
  },
};

function buildRevenueCatUrl(
  metric: string,
  requestUrl: URL,
  env: Env,
  projectId: string,
  scope: MetricScope,
): string {
  const base = (env.REVENUECAT_BASE_URL ?? DEFAULT_BASE_URL).trim();
  const path = resolvePath(
    env.REVENUECAT_ENDPOINT_PATH,
    projectId,
    scope,
    metric,
  );

  const url = new URL(path, ensureTrailingSlash(base));

  const params = new URLSearchParams();

  for (const [key, value] of requestUrl.searchParams.entries()) {
    if (key.startsWith("rc.")) {
      params.set(key.slice(3), value);
    }
  }

  // No additional time-series or app-scoped parameters are supported.

  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function extractBearerToken(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function ensureTrailingSlash(url: string): string {
  if (url.endsWith("/")) {
    return url;
  }
  return `${url}/`;
}

function parseGoalParams(requestUrl: URL): GoalParameters {
  return {
    mrrGoal: parseNonNegativeInteger(requestUrl.searchParams.get("mrr_goal")),
    subscribersGoal: parseNonNegativeInteger(
      requestUrl.searchParams.get("subscribers_goal"),
    ),
  };
}

function parseNonNegativeInteger(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function extractMetricValue(
  payload: RevenueCatResponse,
  scope: MetricScope,
  metric: string,
): MetricValue | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (scope === "overview" && Array.isArray(payload.metrics)) {
    for (const entry of payload.metrics) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.id !== metric) continue;
      const value = pickNumber(record.value);
      if (typeof value === "number") {
        const label = pickLabel(record.description, record.period, record.name);
        return { value, label };
      }
    }
    return null;
  }

  const direct = pickNumber(payload.value, payload.total, payload.current);
  if (typeof direct === "number") {
    return { value: direct };
  }

  if (Array.isArray(payload.data)) {
    for (let i = payload.data.length - 1; i >= 0; i -= 1) {
      const entry = payload.data[i];
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const value = pickNumber(record.value, record.total, record.current);
      if (typeof value === "number") {
        const label = pickLabel(record.label);
        return { value, label };
      }
    }
  }

  return null;
}

function pickNumber(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function prettifyMetricName(metric: string): string {
  return metric
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function parsePrecision(raw?: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 6) {
    return parsed;
  }
  return 0;
}

function formatNumber(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

function jsonError(message: string, status: number): Response {
  const body = JSON.stringify({
    frames: [
      {
        text: `Error: ${message}`,
        icon: "i18445",
      },
    ],
    error: message,
  });

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function resolveScope(requestUrl: URL, env: Env): MetricScope {
  // Only overview scope is supported.
  return DEFAULT_SCOPE;
}

function resolvePath(
  overridePath: string | undefined,
  projectId: string,
  scope: MetricScope,
  metric: string,
): string {
  const trimmedOverride = overridePath?.replace(/^\//, "");
  if (trimmedOverride) {
    return trimmedOverride;
  }

  // Only overview metrics endpoint is supported.
  return `projects/${projectId}/metrics/overview`;
}

function pickLabel(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function isOverviewBundle(metric: string, scope: MetricScope): boolean {
  return scope === "overview" && metric === OVERVIEW_BUNDLE_METRIC;
}

type MetricRecord = Record<string, unknown> & {
  id?: unknown;
  unit?: unknown;
  name?: unknown;
  description?: unknown;
  period?: unknown;
  value?: unknown;
  current?: unknown;
  total?: unknown;
};

type OverviewMetricConfig = {
  id: string;
  icon: string;
  label?: string;
  precision?: number;
};

const OVERVIEW_METRIC_PRESETS: OverviewMetricConfig[] = [
  { id: "active_users", icon: "42832", label: "Active Users" },
  { id: "new_customers", icon: "406", label: "New Customers" },
  { id: "revenue", icon: "30756", label: "Revenue" },
  { id: "active_subscriptions", icon: "40354", label: "Subscribers" },
  { id: "active_trials", icon: "41036", label: "Trials" },
  { id: "mrr", icon: "30756", label: "MRR" },
];

function buildOverviewBundleFrames(
  payload: RevenueCatResponse,
  requestUrl: URL,
  env: Env,
  goals: GoalParameters,
): Frame[] {
  const metrics = Array.isArray(payload.metrics)
    ? (payload.metrics.filter(
        (entry): entry is MetricRecord =>
          entry !== null && typeof entry === "object",
      ) as MetricRecord[])
    : [];

  if (metrics.length === 0) {
    return [];
  }

  const byId = new Map<string, MetricRecord>();
  for (const metric of metrics) {
    const id = typeof metric.id === "string" ? metric.id : undefined;
    if (id) {
      byId.set(id, metric);
    }
  }

  const frames: Frame[] = [];
  const consumed = new Set<string>();
  const fallbackIcon =
    requestUrl.searchParams.get("icon") ?? env.DEFAULT_ICON ?? "i2381";

  for (const preset of OVERVIEW_METRIC_PRESETS) {
    const record = byId.get(preset.id);
    if (!record) continue;
    const formatted = formatOverviewMetric(record, preset.precision ?? 0);
    if (!formatted) continue;
    frames.push({
      text: `${preset.label ?? prettifyMetricName(preset.id)}: ${formatted}`,
      icon: preset.icon,
    });
    consumed.add(preset.id);
  }

  for (const metric of metrics) {
    const id = typeof metric.id === "string" ? metric.id : undefined;
    if (!id || consumed.has(id)) continue;
    const rawValue = pickNumber(metric.value);
    if (rawValue === null || rawValue === 0) continue;
    const formatted = formatOverviewMetric(metric, 0);
    if (!formatted) continue;
    const label =
      typeof metric.name === "string" ? metric.name : prettifyMetricName(id);
    frames.push({
      text: `${label}: ${formatted}`,
      icon: fallbackIcon,
    });
  }

  const goalFrames = buildOverviewGoalFrames(goals, byId);

  return frames.concat(goalFrames);
}

function buildSingleMetricFrames(
  metricValue: MetricValue,
  metric: string,
  requestUrl: URL,
  env: Env,
  goals: GoalParameters,
): Frame[] {
  const label =
    requestUrl.searchParams.get("label") ??
    env.DEFAULT_LABEL ??
    prettifyMetricName(metric);
  const suffix =
    requestUrl.searchParams.get("suffix") ?? env.DEFAULT_SUFFIX ?? "";
  const icon =
    requestUrl.searchParams.get("icon") ?? env.DEFAULT_ICON ?? "i2381";
  const precision = parsePrecision(
    requestUrl.searchParams.get("precision") ?? env.DEFAULT_PRECISION,
  );

  const formattedValue = formatNumber(metricValue.value, precision);

  const frames: Frame[] = [
    {
      text: `${label}: ${formattedValue}${suffix}`,
      icon,
    },
  ];

  if (metricValue.label) {
    frames.push({
      text: `${metricValue.label}`,
      icon,
    });
  }

  const goalFrame = buildSingleMetricGoalFrame(metric, metricValue.value, goals);
  if (goalFrame) {
    frames.push(goalFrame);
  }

  return frames;
}

function formatOverviewMetric(
  metric: MetricRecord,
  precision: number,
): string | null {
  const value = pickNumber(metric.value);
  if (typeof value !== "number") {
    return null;
  }

  const unit = typeof metric.unit === "string" ? metric.unit.trim() : "";
  const formatted = formatNumber(value, precision);

  if (!unit || unit === "#") {
    return formatted;
  }

  if (/^[€£$¥₹₽₩₺₫₴฿₦₱₪₫₭₡₲₱₵₸₮₦₤₯₠₢₣₤₥₦₨₩₫₭₮₯]+$/.test(unit)) {
    return `${unit}${formatted}`;
  }

  return `${formatted} ${unit}`;
}

function buildOverviewGoalFrames(
  goals: GoalParameters,
  metricsById: Map<string, MetricRecord>,
): Frame[] {
  const frames: Frame[] = [];

  if (typeof goals.mrrGoal === "number") {
    const metric = metricsById.get("mrr");
    const current = metric
      ? pickNumber(metric.current, metric.value, metric.total)
      : null;
    if (typeof current === "number") {
      frames.push(buildGoalFrame(current, goals.mrrGoal, "30756"));
    }
  }

  if (typeof goals.subscribersGoal === "number") {
    const metric = metricsById.get("active_subscriptions");
    const current = metric
      ? pickNumber(metric.current, metric.value, metric.total)
      : null;
    if (typeof current === "number") {
      frames.push(buildGoalFrame(current, goals.subscribersGoal, "40354"));
    }
  }

  return frames;
}

function buildSingleMetricGoalFrame(
  metric: string,
  currentValue: number,
  goals: GoalParameters,
): Frame | null {
  if (!Number.isFinite(currentValue)) {
    return null;
  }

  if (isMrrMetric(metric) && typeof goals.mrrGoal === "number") {
    return buildGoalFrame(currentValue, goals.mrrGoal, "30756");
  }

  if (
    isSubscribersMetric(metric) &&
    typeof goals.subscribersGoal === "number"
  ) {
    return buildGoalFrame(currentValue, goals.subscribersGoal, "40354");
  }

  return null;
}

function buildGoalFrame(current: number, goal: number, icon: string): Frame {
  return {
    icon,
    goalData: {
      start: 0,
      current,
      end: goal,
      unit: "",
    },
  };
}

function isMrrMetric(metric: string): boolean {
  return metric === "mrr";
}

function isSubscribersMetric(metric: string): boolean {
  return metric === "active_subscriptions" || metric === "subscribers";
}
