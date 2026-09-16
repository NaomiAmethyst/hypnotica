# SPDX-License-Identifier: GPL-3.0-only
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS
ARG TARGETARCH
ARG SOURCE_URL=https://github.com/NaomiAmethyst/hypnotica
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /hypnotica ./cmd/hypnotica

RUN printf 'Source: %s\n' "$SOURCE_URL" > /SOURCE.txt

FROM scratch
COPY --from=build /hypnotica /hypnotica
COPY LICENSE THIRD_PARTY.md /usr/share/doc/hypnotica/
COPY LICENSES/ /usr/share/doc/hypnotica/LICENSES/
COPY --from=build /SOURCE.txt /usr/share/doc/hypnotica/SOURCE.txt
ENTRYPOINT ["/hypnotica"]
