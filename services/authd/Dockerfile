# authd is a sidecar in the Stalwart pod. It is built static and shipped on
# distroless: the image contains the binary and nothing else - no shell, no
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
#
# THE ARG NAME MUST MATCH THE ONE build.yml PASSES. A build-arg the Dockerfile
# does not declare is silently ignored, and `-X` against a symbol that does not
# exist is silently ignored too - so a mismatch here produces an image that
# builds, runs, and reports its version as "dev" forever.
ARG GIT_SHA=dev
RUN CGO_ENABLED=0 go build \
        -trimpath \
        -ldflags="-s -w -X main.version=${GIT_SHA}" \
        -o /out/ ./cmd/authd ./cmd/mailfront ./cmd/cahookrelay ./cmd/enrolld ./cmd/enrollctl ./cmd/acmed

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/authd /usr/local/bin/authd
# THE MAIL FRONT IS A SECOND BINARY IN THIS IMAGE, NOT A SECOND IMAGE, so the
# two always come from the same commit and the deploy pins one digest. It runs
# as its own container with `command: [/usr/local/bin/mailfront]` and none of
# authd's secrets (services/authd/README.md, "Mail front").
COPY --from=build /out/mailfront /usr/local/bin/mailfront
# Loopback TLS SCEP webhook sidecar for step-ca (handles SCEP hooks against i10-enroll-redis).
COPY --from=build /out/cahookrelay /usr/local/bin/cahookrelay
# Apple over-the-air enrollment HTTP service (keyless edge parser; relays signed profiles from enrollctl).
COPY --from=build /out/enrolld /usr/local/bin/enrolld
# Internal enrollment control service (profile signer, micro-batcher, Mac ACME issuer).
COPY --from=build /out/enrollctl /usr/local/bin/enrollctl
# Keyless Mac device-attest-01 ACME server (delegates issuance to enrollctl /acme/finalize).
COPY --from=build /out/acmed /usr/local/bin/acmed

# Loopback only. The pod spec must not publish this port, and the Service must
# not select it - Stalwart reaches authd over localhost inside the same pod.
# (The mail front's 993 and 465 are published by the pod spec, on the pod IP.)
EXPOSE 3893

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/authd"]
