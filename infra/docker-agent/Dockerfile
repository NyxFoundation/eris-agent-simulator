# Canonical eris agent-runtime image.
#
# The whole point: the operator (live) and participants (local dev / self-test) run agents in THIS
# same image with the same resource caps, so a `--memory` limit verified locally matches production
# exactly. Participants can therefore confirm their agent stays within the memory budget before they
# ever submit.
#
# Self-contained: the runtime (sdk + core + example + the tsx/esbuild toolchain) is baked via
# `npm ci`. No host bind-mount needed. Put a participant's agent under example/agents/<id>/ (it is
# copied in) and select it with ERIS_AGENT_DIR at run time.
FROM node:24-bookworm-slim
WORKDIR /eris

# Dependency layer first, so it caches unless a manifest changes.
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY core/package.json core/
COPY example/package.json example/
COPY dashboard/package.json dashboard/
RUN npm ci

# Source (see .dockerignore: node_modules, .git, runs, cache and the 3.6G deployer/vendor are excluded).
COPY . .

ENV NODE_ENV=production

# bot.ts drives the agent from ERIS_AGENT_DIR; the rest of the env contract (RPC, key, price feed,
# run dir, ERIS_LOCAL_DEPLOY, LLM creds) is supplied at `docker run` time. See infra/docker-agent/README.md.
ENTRYPOINT ["node", "--import", "tsx", "example/agents/runtime/bot.ts"]
