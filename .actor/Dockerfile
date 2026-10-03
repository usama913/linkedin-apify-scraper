FROM apify/actor-node-puppeteer-chrome:20

WORKDIR /usr/src/app

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=myuser . ./

CMD ["npm", "start"]
