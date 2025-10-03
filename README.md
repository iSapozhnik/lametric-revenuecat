# lametric-revenuecat

Cloudflare Worker that turns RevenueCat metrics into a LaMetric dashboard widget. The worker calls the RevenueCat API on demand and returns the answer in the JSON format expected by LaMetric, so the clock can poll the endpoint on a schedule.

## Prerequisites

- [Node.js 20+](https://nodejs.org/) and npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`) for local development and deployment
- RevenueCat **Read-Only API Key** with access to the metrics you want to display (the LaMetric widget will send it in the `Authorization` header)

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

## Request Parameters

The worker accepts query parameters so you can tailor the LaMetric output per-widget without redeploying.

| Parameter      | Description                                                                                                                                   | Default                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `metric`       | RevenueCat metric identifier. Use `overview_bundle` (default) for the prebuilt dashboard, or any specific metric id to return a single value. | `DEFAULT_METRIC` env or `overview_bundle` |
| `scope`        | Data source: `overview` (project snapshot metrics) or `chart` (time-series developer metrics).                                                | `DEFAULT_SCOPE` env or `overview`         |
| `label`        | Text prefix shown on the LaMetric frame.                                                                                                      | Title-cased metric slug                   |
| `suffix`       | Text appended after the numeric value (e.g. ` subs`, ` €`).                                                                                   | Empty string                              |
| `precision`    | Number of decimal digits (0–6).                                                                                                               | `DEFAULT_PRECISION` env or `0`            |
| `icon`         | LaMetric icon identifier.                                                                                                                     | `DEFAULT_ICON` env or `i2381`             |
| `project`      | RevenueCat project id.                                                                                                                        | **Required**                              |
| `app_id`       | RevenueCat app id used for chart scope requests.                                                                                              | –                                         |
| `period`       | Metrics period (passed to RevenueCat `period` query parameter).                                                                               | `DEFAULT_PERIOD` env                      |
| `granularity`  | Metrics granularity (passed to `granularity`).                                                                                                | `DEFAULT_GRANULARITY` env                 |
| `start`, `end` | Optional start/end timestamps forwarded to RevenueCat.                                                                                        | `DEFAULT_START` / `DEFAULT_END` env       |
| `rc.<name>`    | Any other RevenueCat query parameter (e.g. `rc.currency=USD`).                                                                                | –                                         |

## Authentication and Required Parameters

- Include your RevenueCat Read-Only API key in the `Authorization` header (`Authorization: Bearer <token>`). The worker forwards this token to RevenueCat and does not store it server-side.
- Provide the RevenueCat project id via the `project` query parameter. It is required for every request.
- For `scope=chart`, also send an `app_id` query parameter (directly or via `rc.app_id`) so RevenueCat can resolve the app-specific developer metrics.

## Example

By default the worker returns a multi-frame dashboard sourced from RevenueCat's overview metrics:

```
https://<your-worker>.workers.dev/
```

Sample response:

```json
{
  "frames": [
    { "text": "Active Users: 8,054", "icon": "42832" },
    { "text": "New Customers: 560", "icon": "406" },
    { "text": "Revenue: $95", "icon": "30756" },
    { "text": "Subscribers: 68", "icon": "40354" },
    { "text": "Trials: 0", "icon": "41036" },
    { "text": "MRR: $47", "icon": "30756" }
  ]
}
```

For a single metric value, specify the `metric` (and switch to `scope=chart` if you want the time-series developer metrics endpoint):

```
https://<your-worker>.workers.dev/?metric=active_subscriptions&scope=overview&label=Subs&icon=i1234
```

If the RevenueCat API response includes a label (for example the period end date), a second frame with that label is appended automatically.

## Environment Reference

The worker does not store RevenueCat credentials; provide them per-request instead.

All configuration options can be set as Worker variables (via `wrangler.toml` or `wrangler secret put`) and overridden per-request with query parameters.

| Variable                       | Purpose                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `REVENUECAT_BASE_URL`          | Custom RevenueCat API base URL (defaults to `https://api.revenuecat.com/v2/`).               |
| `REVENUECAT_ENDPOINT_PATH`     | Override the path appended to the base URL. Useful for experimental endpoints.               |
| `DEFAULT_METRIC`               | Default metric identifier used when `metric` is not provided (`overview_bundle` by default). |
| `DEFAULT_SCOPE`                | Default scope (`overview` or `chart`) used when `scope` is not provided.                     |
| `DEFAULT_LABEL`                | Default label prefix for the LaMetric frame.                                                 |
| `DEFAULT_SUFFIX`               | Default suffix appended after the numeric value.                                             |
| `DEFAULT_ICON`                 | Default LaMetric icon identifier.                                                            |
| `DEFAULT_PRECISION`            | Default decimal precision (0–6).                                                             |
| `DEFAULT_PERIOD`               | Default `period` parameter passed to RevenueCat.                                             |
| `DEFAULT_GRANULARITY`          | Default `granularity` parameter.                                                             |
| `DEFAULT_START`, `DEFAULT_END` | Default `start` / `end` parameters, if your metric requires them.                            |

## Notes

- The worker surfaces RevenueCat errors directly in the LaMetric frame (`Error: …`) so you can spot configuration issues from the device.
- Responses are cacheable by LaMetric for 30 seconds; adjust the cache header in `src/index.ts` if you need a different cadence.
- If you need to hit a completely custom RevenueCat endpoint, set `REVENUECAT_ENDPOINT_PATH` (or provide `rc.*` overrides) to match the required query parameters.
- `scope=overview` calls RevenueCat's `/metrics/overview` endpoint and returns the latest snapshot for the requested metric id.
- `scope=chart` routes to `/charts/developer_metrics/<metric>`; be sure to provide an `app_id` plus any required `period`, `granularity`, `start`, or `end` parameters.
