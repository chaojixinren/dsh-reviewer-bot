# Isolation image for write-mode validation in the standalone GitHub Action.
#
# `@dshrb/runtime-bootstrap`'s DockerSandboxProvider runs validation commands as
# `docker run --rm -v <workspace>:<workspace> <image> <argv...>`. The image's job
# is to carry the toolchain the repo's own validation commands need, while its
# own filesystem stays ephemeral so those commands cannot mutate anything but the
# bind-mounted workspace.
#
# Two constraints drive the shape below:
#   1. No ENTRYPOINT shell wrapper: `docker run <image> <argv...>` must exec the
#      argv directly, never through a shell, preserving the JSON-argv red line.
#   2. The default user must match the GitHub Actions runner uid/gid (1001) so
#      files written back into the bind-mounted workspace keep the correct owner.
#
# Built and pushed to GHCR by `.github/workflows/docker.yml`.

FROM node:24-bookworm-slim

# Toolchain for typical Node repos: git (git deps), ca-certificates + openssh
# (HTTPS/SSH fetches). Kept minimal; consumers can layer more on top.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

# pnpm is the repo's packageManager; corepack supplies it on first use.
RUN corepack enable

# Match the GitHub-hosted runner identity so workspace writes keep correct
# ownership. The Action mounts the workspace and runs the image's default user.
ARG UID=1001
ARG GID=1001
RUN groupadd --gid "${GID}" runner \
    && useradd --uid "${UID}" --gid "${GID}" --create-home runner

USER runner
WORKDIR /workspace

# Intentionally no ENTRYPOINT and no CMD: the container command is supplied as
# the exact argv after the image name by the sandbox provider.
