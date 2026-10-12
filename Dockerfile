# Deployment artifacts only. Nothing in this repository deploys itself; see docs/PRODUCTION_DEPLOYMENT.md.
# Build:  docker build --target api -t tripos-api .   |   docker build --target web -t tripos-web .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/pricing/package.json packages/pricing/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/pricing/dist ./packages/pricing/dist
COPY --from=build /repo/packages/pricing/package.json ./packages/pricing/
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/package.json ./apps/api/
WORKDIR /repo/apps/api
USER node
EXPOSE 4100
HEALTHCHECK CMD wget -qO- http://localhost:4100/health || exit 1
CMD ["node", "dist/main.js"]

FROM node:22-alpine AS web
WORKDIR /repo/apps/web
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/web/.next ./.next
COPY --from=build /repo/apps/web/package.json /repo/apps/web/next.config.mjs ./
USER node
EXPOSE 3100
CMD ["npx", "next", "start", "-p", "3100"]
