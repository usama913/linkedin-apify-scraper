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

    // Recommended:
    // Try direct first, then use proxy only if direct fails.
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

        if (pathname.startsWith('/organization-guest/')) {
            return url;
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
// Request Queues
// ------------------------------------------------------------

const requestQueue = await RequestQueue.open();

const proxyQueue = await RequestQueue.open(
    `linkedin-profile-proxy-${Date.now()}`
);


// ------------------------------------------------------------
// Add initial direct requests
// ------------------------------------------------------------

for (const originalUrl of limitedUrls) {
    const convertedUrl = convertLinkedInUrl(originalUrl);

    await requestQueue.addRequest({
        url: convertedUrl,

        userData: {
            originalUrl,
            isProxyUsed: false,
            isProxyFallback: false,
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
        throw new Error(
            'No data was returned from LinkedIn profile.'
        );
    }

    const sanitizedResults = sanitizeForDataset(results);

    if (!sanitizedResults || sanitizedResults.length === 0) {
        throw new Error(
            'Scraped data became empty after sanitization.'
        );
    }

    // --------------------------------------------------------
    // IMPORTANT:
    // Dataset write happens BEFORE charging.
    // --------------------------------------------------------

    await Actor.pushData(sanitizedResults);

    return sanitizedResults;
}


// ------------------------------------------------------------
// Mark successful profile
// ------------------------------------------------------------

async function markProfileSuccessful({
    originalUrl,
    results,
    isProxyUsed,
    log,
}) {
    const profileKey = originalUrl.toLowerCase();

    // --------------------------------------------------------
    // Prevent duplicate charging.
    // --------------------------------------------------------

    if (successfulProfiles.has(profileKey)) {
        log.info(
            `Profile already processed successfully. Skipping duplicate charge: ${originalUrl}`
        );

        return;
    }

    // --------------------------------------------------------
    // IMPORTANT:
    // Charge only after successful Dataset write.
    // --------------------------------------------------------

    await Actor.charge({
        eventName: 'profile-scraped',
        count: 1,
    });

    successfulProfiles.add(profileKey);

    successfulCount++;

    if (isProxyUsed) {
        proxySuccessCount++;
    } else {
        directSuccessCount++;
    }

    log.info(
        `Successfully scraped profile: ${originalUrl}`
    );

    log.info(
        `Items returned: ${results.length}`
    );

    log.info(
        `Billing event recorded: profile-scraped ($0.005)`
    );
}


// ------------------------------------------------------------
// Store final failure
// ------------------------------------------------------------

async function storeFailure({
    originalUrl,
    error,
    isProxyUsed,
}) {
    const profileKey = originalUrl.toLowerCase();

    // --------------------------------------------------------
    // Do not write a failure if the profile was already
    // successfully processed by another crawler.
    // --------------------------------------------------------

    if (successfulProfiles.has(profileKey)) {
        return;
    }

    await Actor.pushData(
        sanitizeForDataset({
            url: originalUrl,
            status: 'failed',
            note: error?.message || 'Unknown scraping error',
            isProxyUsed: Boolean(isProxyUsed),
        })
    );
}


// ------------------------------------------------------------
// Queue proxy fallback
// ------------------------------------------------------------

async function queueProxyFallback({
    originalUrl,
    url,
    log,
}) {
    if (!proxyConfiguration) {
        return false;
    }

    const profileKey = originalUrl.toLowerCase();

    if (successfulProfiles.has(profileKey)) {
        log.info(
            `Profile already succeeded. Proxy fallback is not required: ${originalUrl}`
        );

        return false;
    }

    const convertedUrl = convertLinkedInUrl(url);

    await proxyQueue.addRequest({
        url: convertedUrl,

        // Unique key is required because this URL already existed
        // in the direct queue.
        uniqueKey: `${convertedUrl}-proxy-fallback`,

        userData: {
            originalUrl,
            isProxyUsed: true,
            isProxyFallback: true,
            retryCount: 0,
        },
    });

    log.info(
        `Queued proxy fallback for: ${originalUrl}`
    );

    return true;
}


// ------------------------------------------------------------
// Direct crawler
// ------------------------------------------------------------

const directCrawler = new PuppeteerCrawler({
    requestQueue,

    // IMPORTANT:
    // Direct crawler must NOT use a proxy.
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

        log.info(
            `Scraping LinkedIn profile directly: ${originalUrl}`
        );

        try {
            const results = await scrapeProfile({
                page,
                request,
                log,
                isProxyUsed: false,
            });

            await markProfileSuccessful({
                originalUrl,
                results,
                isProxyUsed: false,
                log,
            });

        } catch (error) {
            failedCount++;

            log.error(
                `Direct scraping failed for ${originalUrl}: ${error.message}`
            );

            // ------------------------------------------------
            // IMPORTANT:
            //
            // Do NOT store a failure yet.
            //
            // First send the profile to the actual proxy queue.
            // ------------------------------------------------

            if (
                useProxyOnlyAfterFail &&
                proxyConfiguration
            ) {
                const queued = await queueProxyFallback({
                    originalUrl,
                    url: request.url,
                    log,
                });

                if (queued) {
                    return;
                }
            }

            // ------------------------------------------------
            // No proxy available or proxy fallback disabled.
            // Store final failure.
            // ------------------------------------------------

            await storeFailure({
                originalUrl,
                error,
                isProxyUsed: false,
            });
        }
    },

    async failedRequestHandler({ request, log }) {
        const originalUrl =
            request.userData?.originalUrl || request.url;

        log.error(
            `Direct request permanently failed: ${originalUrl}`
        );

        // ----------------------------------------------------
        // If Crawlee itself exhausts direct retries, we still
        // need to send the profile to the proxy queue.
        // ----------------------------------------------------

        if (
            useProxyOnlyAfterFail &&
            proxyConfiguration
        ) {
            const queued = await queueProxyFallback({
                originalUrl,
                url: request.url,
                log,
            });

            if (queued) {
                return;
            }
        }

        await storeFailure({
            originalUrl,
            error: new Error(
                'Direct request permanently failed.'
            ),
            isProxyUsed: false,
        });
    },
});


// ------------------------------------------------------------
// Proxy crawler
// ------------------------------------------------------------

const proxyCrawler = new PuppeteerCrawler({
    requestQueue: proxyQueue,

    // IMPORTANT:
    // This crawler is the ONLY crawler that uses the proxy.
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
            `Scraping LinkedIn profile with proxy: ${originalUrl}`
        );

        try {
            const results = await scrapeProfile({
                page,
                request,
                log,

                // IMPORTANT:
                // This is now definitely true because this handler
                // only belongs to the proxy crawler.
                isProxyUsed: true,
            });

            await markProfileSuccessful({
                originalUrl,
                results,
                isProxyUsed: true,
                log,
            });

        } catch (error) {
            failedCount++;

            log.error(
                `Proxy scraping failed for ${originalUrl}: ${error.message}`
            );

            // ------------------------------------------------
            // Proxy has now failed.
            //
            // This is the FINAL failure.
            // ------------------------------------------------

            await storeFailure({
                originalUrl,
                error,
                isProxyUsed: true,
            });
        }
    },

    async failedRequestHandler({ request, log }) {
        const originalUrl =
            request.userData?.originalUrl || request.url;

        log.error(
            `Proxy request permanently failed: ${originalUrl}`
        );

        await storeFailure({
            originalUrl,
            error: new Error(
                'Proxy request permanently failed.'
            ),
            isProxyUsed: true,
        });
    },
});


// ------------------------------------------------------------
// Run direct crawler
// ------------------------------------------------------------

await directCrawler.run();


// ------------------------------------------------------------
// Process proxy queue
// ------------------------------------------------------------

if (
    useProxyOnlyAfterFail &&
    proxyConfiguration
) {
    const proxyInfo = await proxyQueue.getInfo();

    if (
        proxyInfo &&
        proxyInfo.totalRequestCount > 0
    ) {
        logProxyQueueInfo(proxyInfo);

        await proxyCrawler.run();
    }
}


// ------------------------------------------------------------
// Final statistics
// ------------------------------------------------------------

logFinalStats();

function logProxyQueueInfo(proxyInfo) {
    console.log('--------------------------------------------');
    console.log('Proxy Fallback Queue');
    console.log('--------------------------------------------');
    console.log(
        `Proxy requests queued: ${proxyInfo.totalRequestCount}`
    );
    console.log('--------------------------------------------');
}


function logFinalStats() {
    console.log('--------------------------------------------');
    console.log('LinkedIn Profile Scraper - Run Summary');
    console.log('--------------------------------------------');

    console.log(
        `Requested profiles : ${limitedUrls.length}`
    );

    console.log(
        `Successful profiles: ${successfulCount}`
    );

    console.log(
        `Direct successes   : ${directSuccessCount}`
    );

    console.log(
        `Proxy successes    : ${proxySuccessCount}`
    );

    console.log(
        `Failed attempts    : ${failedCount}`
    );

    // --------------------------------------------------------
    // Actual price:
    // $0.005 per successful profile
    // --------------------------------------------------------

    console.log(
        `Estimated PPE      : $${(successfulCount * 0.005).toFixed(3)}`
    );

    console.log('--------------------------------------------');
}


await Actor.exit();