# The managed executor: the runner image plus the pg-boss dispatcher on top.
# Build the runner image first, then this one FROM it, so there is exactly one
# definition of the runner toolchain (claude, git, gh, uv, the Derive CLI):
#
#   docker build -f deploy/runner.Dockerfile -t derive-runner .
#   docker build -f deploy/dispatcher.Dockerfile -t derive-dispatcher .
#
# Config is purely environment — see apps/dispatcher/README.md. The container
# boundary carries the same posture as the runner it wraps: per-workspace
# isolation is the deployment unit, and the model credential comes in via env.
ARG RUNNER_IMAGE=derive-runner
FROM ${RUNNER_IMAGE}

USER root
# The dispatcher app, with its own production deps installed in place. tsx runs
# the TypeScript directly — same no-build-step philosophy as the CLI.
COPY apps/dispatcher /opt/derive-dispatcher
RUN cd /opt/derive-dispatcher && npm install --omit=dev \
    && mkdir -p /data && chown -R runner:runner /opt/derive-dispatcher /data

USER runner
WORKDIR /opt/derive-dispatcher
ENV DISPATCHER_DATA_DIR=/data
ENTRYPOINT ["npx", "tsx", "src/index.ts"]
