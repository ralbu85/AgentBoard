# Keep this protocol version aligned with backend/requirements.txt. Rebuild
# with the current supported Playwright release when upgrading the backend.
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION=1.63.0
WORKDIR /opt/browser-worker
RUN npm install --omit=dev --ignore-scripts playwright-core@${PLAYWRIGHT_VERSION}
COPY worker.cjs .
USER pwuser
CMD ["node", "worker.cjs"]
