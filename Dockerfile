# SPDX-License-Identifier: GPL-3.0-only
FROM golang:1.26 AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /hypnotica ./cmd/hypnotica

FROM scratch
COPY --from=build /hypnotica /hypnotica
ENTRYPOINT ["/hypnotica"]
