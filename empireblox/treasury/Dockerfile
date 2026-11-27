# ---- build stage: compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /workspace/treasury
COPY treasury/package.json treasury/package-lock.json ./
RUN npm ci
COPY treasury/tsconfig.json ./
COPY treasury/src ./src
COPY treasury/sql ./sql
COPY assets/wallet/option-picker.js assets/wallet/option-picker.css ../assets/wallet/
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime stage: slim, non-root, no dev deps ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/treasury/node_modules ./node_modules
COPY --from=build /workspace/treasury/dist ./dist
COPY --from=build /workspace/treasury/sql ./sql
COPY treasury/package.json ./
RUN mkdir -p /var/lib/empireblox-custody/private && chown -R node:node /var/lib/empireblox-custody && chmod 0700 /var/lib/empireblox-custody/private
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
