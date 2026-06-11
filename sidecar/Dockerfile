# Always-on Moobot Terminal sidecar - runs the lens engine in the cloud so
# research/pulse/scout agents keep working with the user's laptop closed.
FROM node:22-slim

# curl: lens agents call the local data API; git: claude code expects it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI - the lens agents run `claude -p` headless, authed by
# CLAUDE_CODE_OAUTH_TOKEN (set as a Fly secret).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app/sidecar
COPY package.json ./
RUN npm install --omit=dev
COPY . ./

ENV MOOBOT_DATA_OK=1
# Server mode is activated by the presence of MOOBOT_TOKEN (a Fly secret).
CMD ["node", "src/index.ts"]
