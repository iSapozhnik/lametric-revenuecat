# lametric-revenuecat

Cloudflare Worker that turns **RevenueCat** metrics into a LaMetric dashboard widget. The Worker calls the RevenueCat **REST API v2** on demand and returns JSON in the format expected by LaMetric’s “My Data (DIY)” app, so your clock can poll the endpoint on a schedule.

## Features
- One endpoint that returns **LaMetric frames** built from RevenueCat **Overview** metrics.
- **Single-metric** mode or **multi-frame** dashboard mode (`overview_bundle`).
- Optional **goal frames** for MRR, Subscribers, and Active Users powered by LaMetric `goalData`.
- Query param passthrough for selected RevenueCat params (e.g. `currency`).
- Safe-by-default: requires **project-scoped** credentials and avoids storing tokens server-side.
- Sensible caching for polling devices.

---

## Prerequisites

- **Node.js 20+** and npm
- **Wrangler CLI** for local dev & deploy (`npm i -g wrangler`)
- A RevenueCat **Secret API key** (project-scoped) with read-only permissions **or** an OAuth access token.
- Your RevenueCat **Project ID** (visible in *Project Settings → General*).

> Authentication header examples
>
> - API key: `Authorization: Bearer sk_…`  
> - OAuth: `Authorization: Bearer atk_…`

---

## Getting Started

```bash
npm install

# Optional defaults (can also be set per-request via query params)
wrangler secret put DEFAULT_METRIC
wrangler secret put DEFAULT_SCOPE
wrangler secret put DEFAULT_LABEL
wrangler secret put DEFAULT_SUFFIX
wrangler secret put DEFAULT_ICON
wrangler secret put DEFAULT_PRECISION
```

Start a local dev server:

```bash
npm run dev
```

Deploy to Cloudflare:

```bash
npm run deploy
```

---

## How it Works

The Worker calls the **Overview Metrics** endpoint in RevenueCat REST API v2:

```
GET https://api.revenuecat.com/v2/projects/{project_id}/metrics/overview
Authorization: Bearer <sk_… or atk_…>
Accept: application/json
```

- API reference: <https://www.revenuecat.com/docs/api-v2> (look for “Get overview metrics for a project”)
- Authentication methods: <https://www.revenuecat.com/docs/projects/authentication> and <https://www.revenuecat.com/docs/projects/oauth-setup>

It converts the latest snapshot values into LaMetric frames. Optionally, the Worker forwards selected query parameters to RevenueCat (for example, `currency=EUR`).

---

## Request Parameters

Tailor the LaMetric output per-widget without redeploying.

| Parameter      | Description                                                                                                                                | Default                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `project`      | **RevenueCat project ID.** Required for every request.                                                                                     | **Required**                              |
| `metric`       | Metric to display. Use `overview_bundle` (multi-frame) or a single metric id from the **Supported metrics** list below.                    | `DEFAULT_METRIC` or `overview_bundle`     |
| `scope`        | Data source selector. Only `overview` is implemented.                                                                                      | `DEFAULT_SCOPE` or `overview`             |
| `label`        | Text prefix shown on the LaMetric frame.                                                                                                   | Title-cased metric slug                   |
| `suffix`       | Text appended after the numeric value (e.g., ` subs`, ` €`).                                                                               | Empty string                              |
| `precision`    | Number of decimal digits (0–6).                                                                                                            | `DEFAULT_PRECISION` or `0`                |
| `icon`         | LaMetric icon identifier (e.g., `i2381`).                                                                                                  | `DEFAULT_ICON` or `i2381`                 |
| `mrr_goal`     | Integer target for Monthly Recurring Revenue. Adds a **goal frame** with icon `30756` when MRR data is available.                          | –                                         |
| `subscribers_goal` | Integer target for active subscribers. Adds a **goal frame** with icon `40354` when subscriber data is available.                  | –                                         |
| `active_users_goal` | Integer target for active users. Adds a **goal frame** with icon `42832` when active user data is available.                      | –                                         |
| `rc.<name>`    | Any additional RevenueCat query parameter forwarded to the API (e.g., `rc.currency=EUR`).                                                  | –                                         |

**Removed (not used):** `app_id`, `period`, `granularity`, `start`, `end`. Time-series and app-specific filters aren’t supported in this Worker.

---

## Supported metrics (Overview)

These metric IDs mirror the overview cards in the RevenueCat dashboard:

| Metric ID              | What you’ll see on LaMetric |
| ---------------------- | --------------------------- |
| `active_trials`        | Active Trials               |
| `active_subscriptions` | Active Subscriptions        |
| `mrr`                  | Monthly Recurring Revenue   |
| `revenue`              | Revenue (last 28 days)      |
| `new_customers`        | New Customers (last 28 days)|
| `active_users`         | Active Users (last 28 days) |

Special value: **`overview_bundle`** — a Worker alias that fetches the full Overview snapshot and renders multiple frames in one response.

> Note: The exact metric set comes from the `/metrics/overview` payload. If RevenueCat adds or renames items in that endpoint, `overview_bundle` will reflect those changes automatically.

---

## Example Requests

**Default multi-frame dashboard** (uses `overview_bundle`):

```
https://<your-worker>.workers.dev/?project=<PROJECT_ID>
```

**Single metric with custom label, icon, precision, and currency**:

```
https://<your-worker>.workers.dev/?project=<PROJECT_ID>&metric=mrr&scope=overview&label=MRR&icon=i1234&precision=0&rc.currency=EUR
```

**Sample LaMetric response** (shape):

```json
{
  "frames": [
    { "text": "Active Users: 8,054", "icon": "42832" },
    { "text": "New Customers: 560",  "icon": "406"   },
    { "text": "Revenue: $95",        "icon": "30756" },
    { "text": "Subscribers: 68",     "icon": "40354" },
    { "text": "Trials: 0",           "icon": "41036" },
    { "text": "MRR: $47",            "icon": "30756" }
  ]
}
```

If the upstream API includes helpful metadata (e.g., a timestamp), the Worker can append it as a second frame automatically (configurable in code).

**Goal frame example** (with `mrr_goal=2000`, `subscribers_goal=120`, and `active_users_goal=1000`):

```json
{
  "frames": [
    { "text": "Active Users: 820", "icon": "42832" },
    {
      "icon": "42832",
      "goalData": { "start": 0, "current": 820, "end": 1000, "unit": "" }
    },
    { "text": "MRR: $1,500", "icon": "30756" },
    {
      "icon": "30756",
      "goalData": { "start": 0, "current": 1500, "end": 2000, "unit": "" }
    },
    { "text": "Subscribers: 95", "icon": "40354" },
    {
      "icon": "40354",
      "goalData": { "start": 0, "current": 95, "end": 120, "unit": "" }
    }
  ]
}
```

---

## Authentication & Security

- **Project-scoped API keys** (`sk_…`) or **OAuth access tokens** (`atk_…`) are accepted via the `Authorization` header.
- The Worker **forwards** the token to RevenueCat and **does not store** it server-side.
- Avoid logging the `Authorization` header or raw responses with sensitive data. Prefer structured logs.
- Use Cloudflare Secrets for all credentials in dev and production.

---

## Environment Variables

The Worker reads configuration from environment variables (via `wrangler.toml` and/or `wrangler secret put`). Request parameters can override these at runtime.

| Variable                   | Purpose                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `REVENUECAT_BASE_URL`      | Custom API base URL (default `https://api.revenuecat.com/v2/`).                                  |
| `REVENUECAT_ENDPOINT_PATH` | Override the endpoint path (default `/projects/{project_id}/metrics/overview`).                  |
| `DEFAULT_METRIC`           | Default metric when `metric` isn’t provided (`overview_bundle` recommended).                     |
| `DEFAULT_SCOPE`            | Default scope (use `overview`). `chart` is **reserved** and not implemented in this Worker.     |
| `DEFAULT_LABEL`            | Default label prefix for LaMetric.                                                                |
| `DEFAULT_SUFFIX`           | Default suffix appended after the numeric value.                                                  |
| `DEFAULT_ICON`             | Default LaMetric icon identifier.                                                                 |
| `DEFAULT_PRECISION`        | Default decimal precision (0–6).                                                                  |
| *(removed)*                | Time-series defaults (`DEFAULT_PERIOD`, `DEFAULT_GRANULARITY`, `DEFAULT_START`, `DEFAULT_END`).   |

---

## LaMetric Output Format

The Worker returns JSON compatible with LaMetric’s **My Data (DIY)** app:

```json
{ "frames": [ { "text": "...", "icon": "i1234" }, ... ] }
```

- Up to **20** frames per response.
- Optional `duration` per frame (max 10,000 ms for non-scrolling text).
- Optional `goalData` frames are emitted automatically when `mrr_goal`, `subscribers_goal`, or `active_users_goal` are supplied.
- Optional `chartData` is supported by LaMetric but not emitted by default.

Refer to LaMetric’s official “My Data (DIY)” JSON spec for all options.

---

## Caching & Rate Limits

- Response headers default to `Cache-Control: public, max-age=30` so clients can poll without hammering the API.
- If RevenueCat returns **HTTP 429**, the Worker surfaces a friendly error frame and can honor the `Retry-After` header for backoff (recommended).

---

## Error Handling

The Worker returns one of the following on failure:
- **HTTP error** with an explanatory JSON body (for API clients).
- **LaMetric frame** with `"text": "Error: …"` so issues are visible on-device.

Common causes:
- Missing `project` parameter.
- Invalid or insufficient credentials.
- Temporary rate limiting (HTTP 429).

---

## Advanced

- **Currency**: Forward a specific display currency with `rc.currency=EUR` (or any supported ISO code).
- **Passthrough parameters**: Any `rc.*` query param is appended to the RevenueCat request. Unsupported params are ignored by the API.
- **Custom endpoints**: For experiments or beta features, set `REVENUECAT_ENDPOINT_PATH` to point the Worker at a different v2 path.

---

## Why only `overview` scope?

This Worker is optimized for **snapshot** metrics that fit on a LaMetric screen. Time-series/chart endpoints are not publicly documented for REST consumption, and LaMetric’s “spike chart” is intentionally simple. If you need historical trends on-device, consider rendering a single frame with a concise summary (e.g., “MRR Δ7d: +3.1%”).

---

## License

MIT

---

## References

- RevenueCat **REST API v2**: <https://www.revenuecat.com/docs/api-v2>
- RevenueCat **API Keys & Authentication**: <https://www.revenuecat.com/docs/projects/authentication>
- RevenueCat **OAuth 2.0 guide**: <https://www.revenuecat.com/docs/projects/oauth-setup>
- RevenueCat **Projects → Project ID**: <https://www.revenuecat.com/docs/projects/overview>
- RevenueCat **Overview metrics** (what this Worker mirrors): <https://www.revenuecat.com/docs/dashboard-and-metrics/overview>
- LaMetric **My Data (DIY)** JSON format: <https://help.lametric.com/support/solutions/articles/6000225467-my-data-diy>
