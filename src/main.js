import { Actor, RequestQueue } from 'apify';
import { DEFAULT_USER_AGENT, PuppeteerCrawler, puppeteerUtils } from 'crawlee';
import { LinkedinPageScrapper } from './linkedinPageScrapper.js';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteer from 'puppeteer-extra';

const AUTH_WALL = 'linkedin.com/authwall';

puppeteer.use(StealthPlugin());

await Actor.init();

const input = await Actor.getInput() ?? {};

const startUrls = (input.startUrls ?? [])
    .map((item) => typeof item === 'string' ? item : item?.url)
    .filter(Boolean);

if (startUrls.length === 0) {
    throw new Error('At least one LinkedIn profile URL is required.');
}

const maxProfiles = Math.min(
    Math.max(Number(input.maxProfiles ?? startUrls.length), 1),
    100,
);

const urls = [...new Set(startUrls)].slice(0, maxProfiles);

const disableImagesStylesFonts = input.disableImagesStylesFonts !== false;
let isProxyUsed = false;

const convertUrl = (url) => {
    // Keep normal LinkedIn profile URLs unchanged. The scraper can also handle
    // LinkedIn organization-guest URLs where applicable.
    return url.trim();
};

const profileUrls = urls.map(convertUrl);

const initialProxyConfig = input.useProxyOnlyAfterFail
    ? await Actor.createProxyConfiguration({ useApifyProxy: false })
    : await Actor.createProxyConfiguration(input.proxy);

const requestQueue = await RequestQueue.open();

for (const [index, url] of profileUrls.entries()) {
    await requestQueue.addRequest({
        url,
        uniqueKey: `profile-${index}-${url}`,
        userData: { profileIndex: index },
    });
}

const crawler = new PuppeteerCrawler({
    requestQueue,
    launchContext: {
        launcher: puppeteer,
        launchOptions: {
            headless: true,
        },
    },
    maxConcurrency: Number(input.maxConcurrency ?? 1),
    maxRequestRetries: Number(input.maxRequestRetries ?? 2),
    proxyConfiguration: initialProxyConfig,
    requestHandlerTimeoutSecs: Number(input.requestHandlerTimeoutSecs ?? 300),
    preNavigationHooks: [
        async ({ page }) => {
            await page.setUserAgent(DEFAULT_USER_AGENT);

            if (disableImagesStylesFonts) {
                await page.setRequestInterception(true);

                page.on('request', async (req) => {
                    const blocked = ['stylesheet', 'font', 'image', 'media'].includes(req.resourceType());

                    try {
                        if (blocked) {
                            await req.abort();
                        } else {
                            await req.continue();
                        }
                    } catch {
                        // Request may already have been handled by the browser.
                    }
                });
            }
        },
    ],
    async requestHandler({ pushData, request, page, log, injectJQuery }) {
        log.info(`Scraping LinkedIn profile: ${request.url}`);

        const process = async () => {
            const url = page.url();

            if (url.includes(AUTH_WALL)) {
                throw new Error('Blocked by LinkedIn Authwall.');
            }

            await injectJQuery();

            const scraper = new LinkedinPageScrapper(
                page,
                log,
                request,
                input,
                pushData,
                isProxyUsed,
            );

            return scraper.process();
        };

        try {
            // Crawlee normally waits for navigation. This is only a short
            // compatibility wait for LinkedIn's redirects.
            try {
                await page.waitForNavigation({ timeout: 1000, waitUntil: 'domcontentloaded' });
            } catch {
                // The page may already be loaded.
            }

            const result = await process();

            if (!result) {
                throw new Error('No data was extracted from the profile.');
            }

            const results = Array.isArray(result) ? result : [result];

            // Persist all scraped data before charging. One successful profile
            // is one billable event, regardless of how many posts it contains.
            for (const item of results) {
                if (item) {
                    await pushData(item);
                }
            }

            // Charge only after the profile result has been made available.
            // Configure "profile-scraped" in Apify Console at $0.10/event.
            const chargeResult = await Actor.charge({
                eventName: 'profile-scraped',
                count: 1,
            });

            if (chargeResult?.chargedCount === 0) {
                log.warning(`Profile ${request.url} was scraped but was not charged because the run charge limit was reached.`);
                return;
            }

            log.info(`Successfully scraped and billed profile: ${request.url}`);
        } catch (error) {
            log.error(`Failed to scrape ${request.url}: ${error?.message ?? error}`);

            const errorItem = {
                url: request.url,
                status: 'failed',
                note: error?.message ?? String(error),
                isProxyUsed,
            };

            // Failed profiles are intentionally not charged.
            await pushData(errorItem);

            throw error;
        }
    },
    async failedRequestHandler({ request, log, pushData, page }) {
        log.error(`Request ${request.url} failed after all retries.`);

        let note = 'Page unreachable.';

        try {
            const url = page?.url?.() ?? '';
            if (url.includes(AUTH_WALL)) {
                note = 'Blocked by LinkedIn Authwall.';
            } else {
                await puppeteerUtils.saveSnapshot(page, {
                    key: `failed-${Date.now()}`,
                    saveHtml: true,
                    saveScreenshot: false,
                });
            }
        } catch {
            // Snapshot is best-effort.
        }

        // If configured, retry the failed URL using the supplied Apify proxy.
        if (
            input.useProxyOnlyAfterFail &&
            !isProxyUsed &&
            input.proxy?.useApifyProxy
        ) {
            isProxyUsed = true;
            crawler.proxyConfiguration = await Actor.createProxyConfiguration(input.proxy);
            crawler.maxRequestRetries = Number(input.maxProxiedRetries ?? 5);

            await requestQueue.addRequest({
                url: request.url,
                uniqueKey: `${request.uniqueKey}-proxied`,
                userData: { ...(request.userData ?? {}), proxiedRetry: true },
                forefront: true,
            });

            log.warning(`Retrying ${request.url} using proxy.`);
            return;
        }

        // Failed profiles are not billable.
        await pushData({
            url: request.url,
            status: 'failed',
            note,
            isProxyUsed,
        });
    },
});

await crawler.run();

await Actor.exit();
