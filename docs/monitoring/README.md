# Monitoring

Everything here runs on free tiers.

| What      | Tool                           | Detail                                                                                                                                                                             |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is it up? | UptimeRobot                    | Three HTTP monitors every 5 minutes: the API (`/readyz`, which also checks the database), the web demo and the demo console. Email alert when one goes down                        |
| Keep warm | UptimeRobot                    | The API's free host sleeps after a quiet spell. The 5-minute check keeps it awake, so visitors rarely see "Waking up the bank"                                                     |
| Metrics   | Grafana Cloud (free)           | Grafana's Metrics Endpoint integration scrapes the API's `/metrics`, which needs a bearer token (`METRICS_TOKEN`)                                                                  |
| Dashboard | Grafana Cloud                  | [nem-api-dashboard.json](nem-api-dashboard.json): requests per second by route, 5xx share, p50 and p95 latency, status classes, database pool use and waits, memory and goroutines |
| Alert     | Grafana Cloud                  | `API 5xx errors`: more than 5% of requests failing with a 5xx for 5 minutes, sent by email                                                                                         |
| Traces    | OpenTelemetry to Grafana Cloud | The API exports spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (not yet confirmed arriving; see below)                                                                            |

## Set it up again

1. **Metrics.** In Grafana Cloud, add a Metrics Endpoint connection for `https://<api>/metrics` with the bearer token. Check `http_requests_total` in Explore.
2. **Dashboard.** Dashboards, New, Import, upload `nem-api-dashboard.json`, and choose the Prometheus data source.
3. **Alert.** Alert rules, New: `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`, above `0.05` for `5m`.
4. **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the full traces URL ending in `/v1/traces` (it is used as given) and `OTEL_EXPORTER_OTLP_HEADERS` to `Authorization=Basic%20<token>`.

## Limits

- The free Grafana trial turns into the free tier after 14 days. Metrics are kept for a short time (about two weeks on free).
- `/readyz` going red means the database is unreachable. A 5xx alert means the API is up but failing requests. Uptime checks cannot tell those apart from a slow cold start, so a single failed check after a long idle is not an incident.
- Trace delivery has not been confirmed from the Grafana side, so treat traces as configured, not proven.
- There is no paging: alerts go to one email address.
