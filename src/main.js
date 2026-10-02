import { Actor } from 'apify';
import { PuppeteerCrawler, RequestQueue } from 'crawlee';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { DEFAULT_USER_AGENT } from 'crawlee';
import LinkedinPageScrapper from './linkedinPageScrapper.js';

puppeteerExtra.use(StealthPlugin());

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    startUrls = [],
    maxProfiles = 10,
    maxItems = 20,

    onlyProfileInfo = false,
    includeProfileInfo = true,

    useProxyOnlyAfterFail = true,
    proxy = {},
    maxProxiedRetries = 2,

    maxConcurrency = 2,
    maxRequestRetries = 1,
    requestHandlerTimeoutSecs = 180,

    disableImagesStylesFonts = true,
} = input;


// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function sanitizeForDataset(value) {
    if (value === null || value === undefined) {
        return undefined;
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value
            .map(item => sanitizeForDataset(item))
            .filter(item => item !== undefined);
    }

    if (typeof value === 'object') {
        const result = {};

        for (const [key, item] of Object.entries(value)) {
            const sanitized = sanitizeForDataset(item);

            if (sanitized !== undefined) {
                result[key] = sanitized;
            }
        }

        return result;
    }

    return value;
}


function normalizeStartUrls(urls) {
    if (!Array.isArray(urls)) {
        return [];
    }

    return urls
        .map(item => {
            if (typeof item === 'string') {
                return item;
            }

            if (item && typeof item.url === 'string') {
                return item.url;
            }

            return null;
        })
        .filter(Boolean);
}


function convertLinkedInUrl(url) {
    if (!url) {
        return url;
    }

    try {
        const parsed = new URL(url);

        if (!parsed.hostname.includes('linkedin.com')) {
            return url;
        }

        const pathname = parsed.pathname;

        if (
            pathname.startsWith('/in/') ||
            pathname.startsWith('/company/') ||
            pathname.startsWith('/school/') ||
            pathname.startsWith('/showcase/')
        ) {
            return `https://www.linkedin.com/organization-guest${pathname}`;
        }

        return url;
    } catch {
        return url;
    }
}


// ------------------------------------------------------------
// Input validation
// ------------------------------------------------------------

const urls = normalizeStartUrls(startUrls);

if (urls.length === 0) {
    throw new Error(
        'No start URLs provided. Please provide at least one LinkedIn profile/company URL.'
    );
}

const limitedUrls = urls.slice(0, Number(maxProfiles));


// ------------------------------------------------------------
// Proxy configuration
// ------------------------------------------------------------

let proxyConfiguration = undefined;

if (proxy?.useApifyProxy !== false) {
    proxyConfiguration = await Actor.createProxyConfiguration({
        useApifyProxy: true,

        apifyProxyGroups: proxy?.apifyProxyGroups || [
            'RESIDENTIAL',
        ],

        proxyUrls: proxy?.proxyUrls || undefined,
    });
}


// ------------------------------------------------------------
// Request Queue
// ------------------------------------------------------------

const requestQueue = await RequestQueue.open();

for (const originalUrl of limitedUrls) {
    const convertedUrl = convertLinkedInUrl(originalUrl);

    await requestQueue.addRequest({
        url: convertedUrl,

        userData: {
            originalUrl,
            isProxyUsed: false,
            retryCount: 0,
        },
    });
}


// ------------------------------------------------------------
// Statistics
// ------------------------------------------------------------

const successfulProfiles = new Set();

let successfulCount = 0;
let failedCount = 0;
let proxySuccessCount = 0;
let directSuccessCount = 0;


// ------------------------------------------------------------
// Scrape function
// ------------------------------------------------------------

async function scrapeProfile({
    page,
    request,
    log,
    isProxyUsed,
}) {
    const scraper = new LinkedinPageScrapper({
        page,
        request,
        log,

        config: {
            maxItems,
            onlyProfileInfo,
            includeProfileInfo,
        },

        isProxyUsed,
    });

    const results = await scraper.process();

    if (!results || results.length === 0) {
        throw new Error('No data was returned from LinkedIn profile.');
    }

    const sanitizedResults = sanitizeForDataset(results);

    if (!sanitizedResults || sanitizedResults.length === 0) {
        throw new Error('Scraped data became empty after sanitization.');
    }

    // --------------------------------------------------------
    // IMPORTANT:
    // Dataset write happens BEFORE charging.
    // --------------------------------------------------------

    await Actor.pushData(sanitizedResults);

    return sanitizedResults;
}


// ------------------------------------------------------------
// Direct crawler
// ------------------------------------------------------------

const directCrawler = new PuppeteerCrawler({
    requestQueue,

    proxyConfiguration: undefined,

    maxConcurrency,
    maxRequestRetries,
    requestHandlerTimeoutSecs,

    launchContext: {
        launcher: puppeteerExtra,
        launchOptions: {
            headless: true,
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.setUserAgent(DEFAULT_USER_AGENT);

            if (disableImagesStylesFonts) {
                await page.setRequestInterception(true);

                page.on('request', request => {
                    const resourceType = request.resourceType();

                    if (
                        resourceType === 'image' ||
                        resourceType === 'stylesheet' ||
                        resourceType === 'font'
                    ) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });
            }
        },
    ],

    async requestHandler({ page, request, log }) {
        const originalUrl =
            request.userData?.originalUrl || request.url;

        log.info(`Scraping LinkedIn profile: ${originalUrl}`);

        try {
            const results = await scrapeProfile({
                page,
                request,
                log,
                isProxyUsed: false,
            });

            const profileKey = originalUrl.toLowerCase();

            // Prevent duplicate charging.
            if (!successfulProfiles.has(profileKey)) {
                await Actor.charge({
                    eventName: 'profile-scraped',
                    count: 1,
                });

                successfulProfiles.add(profileKey);
                successfulCount++;
                directSuccessCount++;
            }

            log.info(
                `Successfully scraped profile: ${originalUrl}`
            );

            log.info(
                `Items returned: ${results.length}`
            );
        } catch (error) {
            failedCount++;

            log.error(
                `Direct scraping failed for ${originalUrl}: ${error.message}`
            );

            // ------------------------------------------------
            // Proxy fallback
            // ------------------------------------------------

            if (useProxyOnlyAfterFail && proxyConfiguration) {
                await requestQueue.addRequest({
                    url: request.url,

                    uniqueKey: `${request.url}-proxy-${Date.now()}`,

                    userData: {
                        originalUrl,
                        isProxyUsed: true,
                        retryCount: 0,
                    },
                });

                log.info(
                    `Queued proxy fallback for ${originalUrl}`
                );

                return;
            }

            // ------------------------------------------------
            // Store failure information.
            // This is NOT charged.
            // ------------------------------------------------

            await Actor.pushData(
                sanitizeForDataset({
                    url: originalUrl,
                    status: 'failed',
                    note: error.message,
                    isProxyUsed: false,
                })
            );
        }
    },

    async failedRequestHandler({ request, log }) {
        const originalUrl =
            request.userData?.originalUrl || request.url;

        log.error(
            `Request permanently failed: ${originalUrl}`
        );
    },
});


// ------------------------------------------------------------
// Proxy crawler
// ------------------------------------------------------------

const proxyQueue = await RequestQueue.open(
    `linkedin-profile-proxy-${Date.now()}`
);

const proxyCrawler = new PuppeteerCrawler({
    requestQueue: proxyQueue,

    proxyConfiguration,

    maxConcurrency: 1,
    maxRequestRetries: maxProxiedRetries,
    requestHandlerTimeoutSecs,

    launchContext: {
        launcher: puppeteerExtra,
        launchOptions: {
            headless: true,
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.setUserAgent(DEFAULT_USER_AGENT);

            if (disableImagesStylesFonts) {
                await page.setRequestInterception(true);

                page.on('request', request => {
                    const resourceType = request.resourceType();

                    if (
                        resourceType === 'image' ||
                        resourceType === 'stylesheet' ||
                        resourceType === 'font'
                    ) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });
            }
        },
    ],

    async requestHandler({ page, request, log }) {
        const originalUrl =
            request.userData?.originalUrl || request.url;

        log.info(
            `Scraping with proxy: ${originalUrl}`
        );

        try {
            const results = await scrapeProfile({
                page,
                request,
                log,
                isProxyUsed: true,
            });

            const profileKey = originalUrl.toLowerCase();

            // ------------------------------------------------
            // Charge only once.
            // ------------------------------------------------

            if (!successfulProfiles.has(profileKey)) {
                await Actor.charge({
                    eventName: 'profile-scraped',
                    count: 1,
                });

                successfulProfiles.add(profileKey);
                successfulCount++;
                proxySuccessCount++;
            }

            log.info(
                `Proxy scraping successful: ${originalUrl}`
            );

            log.info(
                `Items returned: ${results.length}`
            );
        } catch (error) {
            failedCount++;

            log.error(
                `Proxy scraping failed for ${originalUrl}: ${error.message}`
            );

            await Actor.pushData(
                sanitizeForDataset({
                    url: originalUrl,
                    status: 'failed',
                    note: error.message,
                    isProxyUsed: true,
                })
            );
        }
    },

    async failedRequestHandler({ request, log }) {
        const originalUrl =
            request.userData?.originalUrl || request.url;

        log.error(
            `Proxy request permanently failed: ${originalUrl}`
        );
    },
});


// ------------------------------------------------------------
// Run direct crawler
// ------------------------------------------------------------

await directCrawler.run();


// ------------------------------------------------------------
// Process proxy queue
// ------------------------------------------------------------

if (useProxyOnlyAfterFail && proxyConfiguration) {
    const proxyInfo = await proxyQueue.getInfo();

    if (proxyInfo && proxyInfo.totalRequestCount > 0) {
        await proxyCrawler.run();
    }
}


// ------------------------------------------------------------
// Final statistics
// ------------------------------------------------------------

logFinalStats();

function logFinalStats() {
    console.log('--------------------------------------------');
    console.log('LinkedIn Profile Scraper - Run Summary');
    console.log('--------------------------------------------');
    console.log(`Requested profiles : ${limitedUrls.length}`);
    console.log(`Successful profiles: ${successfulCount}`);
    console.log(`Direct successes   : ${directSuccessCount}`);
    console.log(`Proxy successes    : ${proxySuccessCount}`);
    console.log(`Failed attempts    : ${failedCount}`);
    console.log(
        `Estimated PPE      : $${(successfulCount * 0.05).toFixed(2)}`
    );
    console.log('--------------------------------------------');
}


await Actor.exit();