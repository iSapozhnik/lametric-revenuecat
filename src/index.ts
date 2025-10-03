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
  DEFAULT_PERIOD?: string;
  DEFAULT_GRANULARITY?: string;
  DEFAULT_START?: string;
  DEFAULT_END?: string;
}

type MetricValue = {
  value: number;
  label?: string;
};

type RevenueCatResponse = Record<string, unknown> & {
  data?: Array<Record<string, unknown>>;
  metrics?: Array<Record<string, unknown>>;
  value?: number;
  total?: number;
  current?: number;
};

type MetricScope = "overview" | "chart";

const DEFAULT_BASE_URL = "https://api.revenuecat.com/v2/";
const DEFAULT_SCOPE: MetricScope = "overview";
const OVERVIEW_BUNDLE_METRIC = "overview_bundle";

const LEGACY_SCOPE_MAP: Record<string, MetricScope> = {
  overview: "overview",
  chart: "chart",
  charts: "chart",
  developer_metrics: "chart",
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

      if (
        scope === "chart" &&
        !requestUrl.searchParams.has("app_id") &&
        !requestUrl.searchParams.has("rc.app_id")
      ) {
        return jsonError(
          "Query parameter 'app_id' is required when scope is 'chart'",
          400,
        );
      }

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
      let frames: Array<{ text: string; icon: string }> = [];

      if (isOverviewBundle(metric, scope)) {
        frames = buildOverviewBundleFrames(payload, requestUrl, env);
      } else {
        const metricValue = extractMetricValue(payload, scope, metric);
        if (!metricValue) {
          return jsonError("No numeric data found in RevenueCat response", 502);
        }

        frames = buildSingleMetricFrames(metricValue, metric, requestUrl, env);
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

  const scopedPeriod =
    requestUrl.searchParams.get("period") ?? env.DEFAULT_PERIOD;
  if (scopedPeriod) params.set("period", scopedPeriod);

  const granularity =
    requestUrl.searchParams.get("granularity") ?? env.DEFAULT_GRANULARITY;
  if (granularity) params.set("granularity", granularity);

  const start = requestUrl.searchParams.get("start") ?? env.DEFAULT_START;
  if (start) params.set("start", start);

  const end = requestUrl.searchParams.get("end") ?? env.DEFAULT_END;
  if (end) params.set("end", end);

  const appId = requestUrl.searchParams.get("app_id");
  if (appId) {
    params.set("app_id", appId);
  }

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
  const raw =
    requestUrl.searchParams.get("scope") ?? env.DEFAULT_SCOPE ?? DEFAULT_SCOPE;
  const normalized = raw.toLowerCase();
  return LEGACY_SCOPE_MAP[normalized] ?? DEFAULT_SCOPE;
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

  if (scope === "overview") {
    return `projects/${projectId}/metrics/overview`;
  }

  return `projects/${projectId}/charts/developer_metrics/${metric}`;
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
) {
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

  const frames: Array<{ text: string; icon: string }> = [];
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

  return frames;
}

function buildSingleMetricFrames(
  metricValue: MetricValue,
  metric: string,
  requestUrl: URL,
  env: Env,
) {
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

  const frames = [
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
