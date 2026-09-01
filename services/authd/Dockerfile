# authd is a sidecar in the Stalwart pod. It is built static and shipped on
# distroless: the image contains the binary and nothing else — no shell, no
# package manager, no libc to link against.
#
# That matters more here than for a typical service. authd parses
# attacker-influenced bytes (login strings and passwords from any IMAP client,
# recipient addresses from any sending MTA) and holds a Clerk secret key. An
# image with no executables besides the binary gives a foothold nowhere to go.

FROM golang:1.26-alpine AS build

WORKDIR /src

# Dependencies first so the module cache survives source edits.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO off gives a genuinely static binary. -trimpath keeps build paths out of
# the artifact so the same source produces the same bytes anywhere.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build \
        -trimpath \
        -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/authd ./cmd/authd

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/authd /usr/local/bin/authd

# Loopback only. The pod spec must not publish this port, and the Service must
# not select it — Stalwart reaches authd over localhost inside the same pod.
EXPOSE 3893

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/authd"]
