package observability

import (
	"crypto/subtle"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics owns the API's Prometheus registry. A private registry (not the global default)
// keeps tests isolated and makes every exported series a deliberate choice.
type Metrics struct {
	reg      *prometheus.Registry
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inFlight prometheus.Gauge
}

// NewMetrics registers the Go runtime, process and HTTP collectors.
func NewMetrics() *Metrics {
	m := &Metrics{
		reg: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "HTTP requests by method, route template and status code.",
		}, []string{"method", "route", "status"}),
		// Buckets centre on the 200 ms p95 budget (code-standards §8).
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request latency by method and route template.",
			Buckets: []float64{.005, .01, .025, .05, .1, .2, .3, .5, 1, 2.5, 5},
		}, []string{"method", "route"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "http_requests_in_flight",
			Help: "HTTP requests currently being served.",
		}),
	}
	m.reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.requests, m.duration, m.inFlight,
	)
	return m
}

// RegisterPool exports the pgx pool's connection stats.
func (m *Metrics) RegisterPool(pool *pgxpool.Pool) {
	m.reg.MustRegister(newPoolCollector(pool.Stat))
}

// Middleware records every request. Labels use the route template, never the raw path, so
// IDs in URLs neither leak nor explode the series count.
func (m *Metrics) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		m.inFlight.Inc()
		defer m.inFlight.Dec()
		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		m.requests.WithLabelValues(c.Request.Method, route, strconv.Itoa(c.Writer.Status())).Inc()
		m.duration.WithLabelValues(c.Request.Method, route).Observe(time.Since(start).Seconds())
	}
}

// Handler serves the Prometheus text format. With a token set it requires
// "Authorization: Bearer <token>", so a public deploy does not expose internals to anyone.
func (m *Metrics) Handler(token string) gin.HandlerFunc {
	h := promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
	want := []byte("Bearer " + token)
	return func(c *gin.Context) {
		if token != "" && subtle.ConstantTimeCompare([]byte(c.GetHeader("Authorization")), want) != 1 {
			c.Header("WWW-Authenticate", `Bearer realm="metrics"`)
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(c.Writer, c.Request)
	}
}

// poolCollector reads pool stats at scrape time instead of polling.
type poolCollector struct {
	stat                         func() *pgxpool.Stat
	total, idle, acquired, maxC  *prometheus.Desc
	acquireCount, acquireSeconds *prometheus.Desc
	emptyAcquire                 *prometheus.Desc
}

func newPoolCollector(stat func() *pgxpool.Stat) *poolCollector {
	d := func(name, help string) *prometheus.Desc {
		return prometheus.NewDesc("db_pool_"+name, help, nil, nil)
	}
	return &poolCollector{
		stat:           stat,
		total:          d("connections", "Open connections."),
		idle:           d("idle_connections", "Idle connections."),
		acquired:       d("acquired_connections", "Connections in use."),
		maxC:           d("max_connections", "Configured pool size."),
		acquireCount:   d("acquires_total", "Successful connection acquires."),
		acquireSeconds: d("acquire_duration_seconds_total", "Time spent waiting to acquire connections."),
		emptyAcquire:   d("empty_acquires_total", "Acquires that had to wait because the pool was empty."),
	}
}

func (p *poolCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{p.total, p.idle, p.acquired, p.maxC, p.acquireCount, p.acquireSeconds, p.emptyAcquire} {
		ch <- d
	}
}

func (p *poolCollector) Collect(ch chan<- prometheus.Metric) {
	s := p.stat()
	ch <- prometheus.MustNewConstMetric(p.total, prometheus.GaugeValue, float64(s.TotalConns()))
	ch <- prometheus.MustNewConstMetric(p.idle, prometheus.GaugeValue, float64(s.IdleConns()))
	ch <- prometheus.MustNewConstMetric(p.acquired, prometheus.GaugeValue, float64(s.AcquiredConns()))
	ch <- prometheus.MustNewConstMetric(p.maxC, prometheus.GaugeValue, float64(s.MaxConns()))
	ch <- prometheus.MustNewConstMetric(p.acquireCount, prometheus.CounterValue, float64(s.AcquireCount()))
	ch <- prometheus.MustNewConstMetric(p.acquireSeconds, prometheus.CounterValue, s.AcquireDuration().Seconds())
	ch <- prometheus.MustNewConstMetric(p.emptyAcquire, prometheus.CounterValue, float64(s.EmptyAcquireCount()))
}
