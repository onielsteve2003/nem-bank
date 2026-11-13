# syntax=docker/dockerfile:1
# Build context is apps/api: `docker build -t nem-api apps/api`.

# ---- build ----
FROM golang:1.27.4-bookworm AS build
WORKDIR /src

# Dependencies first, so code edits reuse this layer.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
ARG VERSION=dev
# CGO off gives a static binary that runs on distroless/static (no libc).
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/api ./cmd/api

# ---- runtime ----
# Distroless static: CA certificates and tzdata, no shell or package manager. :nonroot runs
# as uid 65532, so a compromised process cannot write to the image or bind low ports.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api

ENV APP_ENV=production PORT=8080
EXPOSE 8080
USER nonroot:nonroot

# No curl in distroless: the binary probes its own /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/api", "healthcheck"]

ENTRYPOINT ["/api"]
