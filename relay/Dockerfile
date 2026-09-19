FROM node:24-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY svelte.config.js vite.config.js tsconfig.json ./
COPY src ./src
COPY relay/artifact-preview.ts ./relay/
COPY static ./static
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY relay/server.ts relay/start.ts relay/web.ts relay/downloads.ts relay/sessions.ts relay/push.ts relay/workspaces.ts relay/manage.ts relay/artifact-preview.ts ./relay/
COPY src/lib/compaction.ts src/lib/domain.ts src/lib/fleet.ts src/lib/sync.ts src/lib/activity.ts src/lib/reasoning.ts src/lib/images.ts src/lib/plans.ts src/lib/workflows.ts src/lib/visualizations.ts src/lib/questions.ts src/lib/steering.ts src/lib/file-changes.ts src/lib/input-templates.ts src/lib/notifications.ts src/lib/installation.ts src/lib/spend.ts src/lib/artifact-preview.html ./src/lib/
COPY --from=frontend /app/build ./build
COPY src/lib/mcp.ts ./src/lib/
ENV AGENT_STUDIO_RELAY_HOST=0.0.0.0 AGENT_STUDIO_RELAY_PORT=4317 AGENT_STUDIO_RELAY_DATA=/data
USER node
EXPOSE 4317
CMD ["node", "relay/start.ts"]
