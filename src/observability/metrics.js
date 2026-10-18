// @ts-check
"use strict";

/**
 * Prometheus metrics collection and rendering.
 *
 * Responsibility: own the counter/histogram shapes and render the Prometheus text format.
 *
 * The metric **names** are a public contract — dashboards and alerts depend on them — so they
 * must never be renamed. New metrics are additive (Phase 6). The functions take the metrics
 * object as an argument rather than reaching for module-level state, which keeps them pure and
 * lets a test render a synthetic snapshot.
 *
 * @typedef {object} Metrics
 * @property {number} requestsTotal
 * @property {Record<string, number>} requestsByMethod
 * @property {Record<string, number>} requestsByStatus
 * @property {Record<string, number>} latencyBuckets
 * @property {number} latencySumSeconds
 * @property {number} errorsTotal
 * @property {number} activeConnections
 * @property {number} rateLimitedTotal
 * @property {number} startTime
 */

/**
 * Creates a zeroed metrics object.
 *
 * Latency buckets are in **milliseconds** here and rendered as seconds; the keys are the
 * documented bucket boundaries.
 *
 * @returns {Metrics}
 */
function createMetrics() {
  return {
    requestsTotal: 0,
    requestsByMethod: {},
    requestsByStatus: {},
    latencyBuckets: { 100: 0, 500: 0, 1000: 0, 5000: 0, 30000: 0, 120000: 0, Infinity: 0 },
    latencySumSeconds: 0,
    errorsTotal: 0,
    activeConnections: 0,
    rateLimitedTotal: 0,
    startTime: Date.now(),
  };
}

/**
 * Records one completed request.
 *
 * @param {Metrics} metrics
 * @param {{ method: string, path: string, status: number, durationMs: number, isError: boolean }} sample
 */
function recordMetrics(metrics, { method, path, status, durationMs, isError }) {
  metrics.requestsTotal += 1;

  const methodKey = `${method} ${path}`;
  metrics.requestsByMethod[methodKey] = (metrics.requestsByMethod[methodKey] || 0) + 1;

  const statusKey = String(status);
  metrics.requestsByStatus[statusKey] = (metrics.requestsByStatus[statusKey] || 0) + 1;

  for (const boundary of Object.keys(metrics.latencyBuckets)) {
    if (durationMs <= Number(boundary)) {
      metrics.latencyBuckets[boundary] += 1;
      break;
    }
  }

  metrics.latencySumSeconds += durationMs / 1000;

  if (isError) {
    metrics.errorsTotal += 1;
  }
}

/**
 * Renders the Prometheus text exposition format.
 *
 * @param {Metrics} metrics
 * @returns {string} text ending in a newline, as the format requires
 */
function renderPrometheusMetrics(metrics) {
  const uptime = (Date.now() - metrics.startTime) / 1000;
  const lines = [
    "# HELP gstitch_proxy_uptime_seconds Proxy uptime in seconds",
    "# TYPE gstitch_proxy_uptime_seconds gauge",
    `gstitch_proxy_uptime_seconds ${uptime}`,
    "",
    "# HELP gstitch_proxy_requests_total Total number of requests",
    "# TYPE gstitch_proxy_requests_total counter",
    `gstitch_proxy_requests_total ${metrics.requestsTotal}`,
    "",
    "# HELP gstitch_proxy_errors_total Total number of errors",
    "# TYPE gstitch_proxy_errors_total counter",
    `gstitch_proxy_errors_total ${metrics.errorsTotal}`,
    "",
    "# HELP gstitch_proxy_active_connections Current active connections",
    "# TYPE gstitch_proxy_active_connections gauge",
    `gstitch_proxy_active_connections ${metrics.activeConnections}`,
    "",
    "# HELP gstitch_proxy_rate_limited_total Total rate-limited requests",
    "# TYPE gstitch_proxy_rate_limited_total counter",
    `gstitch_proxy_rate_limited_total ${metrics.rateLimitedTotal}`,
    "",
    "# HELP gstitch_proxy_requests_by_method Requests by HTTP method and path",
    "# TYPE gstitch_proxy_requests_by_method counter",
  ];

  for (const [key, value] of Object.entries(metrics.requestsByMethod)) {
    lines.push(`gstitch_proxy_requests_by_method{method_path="${key}"} ${value}`);
  }

  lines.push(
    "",
    "# HELP gstitch_proxy_requests_by_status Requests by HTTP status code",
    "# TYPE gstitch_proxy_requests_by_status counter",
  );

  for (const [key, value] of Object.entries(metrics.requestsByStatus)) {
    lines.push(`gstitch_proxy_requests_by_status{status="${key}"} ${value}`);
  }

  lines.push(
    "",
    "# HELP gstitch_proxy_latency_seconds Request latency histogram",
    "# TYPE gstitch_proxy_latency_seconds histogram",
  );

  let cumulative = 0;
  for (const [boundary, count] of Object.entries(metrics.latencyBuckets)) {
    cumulative += count;
    const le = boundary === "Infinity" ? "+Inf" : (Number(boundary) / 1000).toFixed(3);
    lines.push(`gstitch_proxy_latency_seconds_bucket{le="${le}"} ${cumulative}`);
  }

  lines.push(
    `gstitch_proxy_latency_seconds_count ${metrics.requestsTotal}`,
    `gstitch_proxy_latency_seconds_sum ${metrics.latencySumSeconds.toFixed(3)}`,
    "",
  );

  return lines.join("\n") + "\n";
}

module.exports = { createMetrics, recordMetrics, renderPrometheusMetrics };
