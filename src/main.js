import { Actor } from 'apify';
import { DEFAULT_USER_AGENT, PuppeteerCrawler, RequestQueue } from 'crawlee';
import { LinkedinPageScrapper } from './linkedinPageScrapper.js';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteer from 'puppeteer-extra';

const AUTH_WALL = 'linkedin.com/authwall';

puppeteer.use(StealthPlugin());

await Actor.init();

const input = await Actor.getInput() ?? {};

const startUrls = (input.startUrls ?? [])
    .map((item) => typeof item === 'string' ? item : item?.url)
    .filter(Boolean)
    .map((url) => url.trim());

if (startUrls.length === 0) {
    throw new Error('At least one LinkedIn URL is required.');
}

const maxProfiles = Math.min(
    Math.max(Number(input.maxProfiles ?? startUrls.length), 1),
    100
);

const urls = [...new Set(startUrls)].slice(0, maxProfiles);

const maxItems = Number(input.maxItems ?? 10);

const onlyProfileInfo = input.onlyProfileInfo === true;

const includeProfileInfo = input.includeProfileInfo === true;

const useProxyOnlyAfterFail =
    input.useProxyOnlyAfterFail === true;

const maxConcurrency = Math.max(
    1,
    Number(input.maxConcurrency ?? 1)
);

const maxRequestRetries = Math.max(
    0,
    Number(input.maxRequestRetries ?? 2)
);

const maxProxiedRetries = Math.max(
    0,
    Number(input.maxProxiedRetries ?? 5)
);

const requestHandlerTimeoutSecs = Math.max(
    30,
    Number(input.requestHandlerTimeoutSecs ?? 300)
);

const disableImagesStylesFonts =
    input.disableImagesStylesFonts !== false;


/*
|--------------------------------------------------------------------------
| Proxy configuration
|--------------------------------------------------------------------------
*/

const proxyInput = input.proxy ?? {};

const useApifyProxy =
    proxyInput.useApifyProxy === true;

const customProxyUrls =
    Array.isArray(proxyInput.proxyUrls)
        ? proxyInput.proxyUrls.filter(Boolean)
        : [];

const hasProxy =
    useApifyProxy ||
    customProxyUrls.length > 0;

let proxyConfiguration = null;

if (hasProxy) {

    proxyConfiguration =
        await Actor.createProxyConfiguration({
            useApifyProxy,
            proxyUrls: customProxyUrls,
        });
}


/*
|--------------------------------------------------------------------------
| Tracking
|--------------------------------------------------------------------------
*/

const successfulUrls = new Set();

const directFailedUrls = new Map();

const finalFailedUrls = new Set();


/*
|--------------------------------------------------------------------------
| Sanitizer
|--------------------------------------------------------------------------
|
| Removes undefined values and normalizes invalid numbers to null before
| sending data to Apify Dataset. Null values are kept so every output
| item has a stable shape (e.g. "videoUrl": null).
|
*/

function sanitizeForDataset(value) {

    if (value === undefined) {
        return undefined;
    }

    if (value === null) {
        return null;
    }

    if (
        typeof value === 'number' &&
        !Number.isFinite(value)
    ) {
        return null;
    }

    if (typeof value === 'string') {

        return value;
    }

    if (typeof value === 'boolean') {

        return value;
    }

    if (Array.isArray(value)) {

        return value
            .map(item => sanitizeForDataset(item))
            .filter(item => item !== undefined);
    }

    if (typeof value === 'object') {

        const result = {};

        for (const [key, item] of Object.entries(value)) {

            const sanitized =
                sanitizeForDataset(item);

            if (sanitized !== undefined) {
                result[key] = sanitized;
            }
        }

        return result;
    }

    return value;
}


/*
|--------------------------------------------------------------------------
| Convert LinkedIn company/school URLs
|--------------------------------------------------------------------------
*/

function convertUrl(url) {

    if (!url) {
        return url;
    }

    if (url.includes('/organization-guest/')) {
        return url;
    }

    return url.replace(
        /(https:\/\/[^/]*linkedin\.com\/)(school|company|showcase)\//,
        '$1organization-guest/$2/'
    );
}


/*
|--------------------------------------------------------------------------
| Create Request Queue
|--------------------------------------------------------------------------
*/

async function createQueue(urlsToProcess, name) {

    const queue = await RequestQueue.open(name);

    for (let index = 0; index < urlsToProcess.length; index++) {

        const url = convertUrl(urlsToProcess[index]);

        await queue.addRequest({

            url,

            uniqueKey:
                `${name}-${index}-${url}`,

            userData: {
                originalUrl: urlsToProcess[index],
                profileIndex: index,
            },
        });
    }

    return queue;
}


/*
|--------------------------------------------------------------------------
| Browser setup
|--------------------------------------------------------------------------
*/

async function setupPage({ page }) {

    await page.setUserAgent(
        DEFAULT_USER_AGENT
    );

    if (!disableImagesStylesFonts) {
        return;
    }

    await page.setRequestInterception(true);

    page.on('request', async (request) => {

        try {

            const resourceType =
                request.resourceType();

            if (
                resourceType === 'stylesheet' ||
                resourceType === 'font' ||
                resourceType === 'image' ||
                resourceType === 'media'
            ) {

                await request.abort();

            } else {

                await request.continue();

            }

        } catch {
            // Request may already have been handled.
        }
    });
}


/*
|--------------------------------------------------------------------------
| Check Authwall
|--------------------------------------------------------------------------
*/

function isAuthWall(url) {

    return Boolean(
        url &&
        url.includes(AUTH_WALL)
    );
}


/*
|--------------------------------------------------------------------------
| Scrape a profile
|--------------------------------------------------------------------------
*/

async function scrapeProfile({
    page,
    request,
    log,
    injectJQuery,
    isProxyUsed,
}) {

    log.info(
        `Scraping LinkedIn profile: ${request.url} | proxy=${isProxyUsed}`
    );


    /*
     * Wait for initial navigation.
     */

    try {

        await page.waitForNavigation({
            timeout: 2000,
            waitUntil: 'domcontentloaded',
        });

    } catch {
        // Page may already be loaded.
    }


    /*
     * Check Authwall.
     */

    if (isAuthWall(page.url())) {

        throw new Error(
            'Blocked by LinkedIn Authwall.'
        );
    }


    /*
     * Inject jQuery.
     */

    await injectJQuery();


    /*
     * Existing scraper.
     *
     * IMPORTANT:
     * The scraper no longer pushes directly to Dataset.
     * It returns an array of results.
     */

    const scraper =
        new LinkedinPageScrapper(
            page,
            log,
            request,
            input,
            isProxyUsed
        );


    const result =
        await scraper.process();


    if (!result) {

        throw new Error(
            'Scraper returned no result.'
        );
    }


    const results =
        Array.isArray(result)
            ? result
            : [result];


    /*
     * Sanitize all records BEFORE pushing.
     */

    const sanitizedResults =
        results
            .map(item =>
                sanitizeForDataset(item)
            )
            .filter(
                item =>
                    item !== undefined &&
                    item !== null
            );


    if (sanitizedResults.length === 0) {

        throw new Error(
            'Scraper returned no valid dataset items.'
        );
    }


    /*
     * Push the COMPLETE batch at once.
     *
     * This prevents duplicate posts if one item fails
     * after earlier items were already inserted.
     */

    await Actor.pushData(
        sanitizedResults
    );


    return sanitizedResults;
}


/*
|--------------------------------------------------------------------------
| Direct crawler
|--------------------------------------------------------------------------
*/

async function runDirectCrawler() {

    const queue =
        await createQueue(
            urls,
            `linkedin-direct-${Date.now()}`
        );


    const crawler =
        new PuppeteerCrawler({

            requestQueue: queue,

            launchContext: {

                launcher: puppeteer,

                launchOptions: {
                    headless: true,
                },
            },

            maxConcurrency,

            maxRequestRetries,

            requestHandlerTimeoutSecs,


            preNavigationHooks: [
                setupPage,
            ],


            async requestHandler({
                page,
                request,
                log,
                injectJQuery,
            }) {

                try {

                    const results =
                        await scrapeProfile({
                            page,
                            request,
                            log,
                            injectJQuery,
                            isProxyUsed: false,
                        });


                    successfulUrls.add(
                        request.url
                    );


                    /*
                     * IMPORTANT:
                     *
                     * Charge only after Dataset push succeeds.
                     *
                     * One profile = one billing event.
                     */

                    await Actor.charge({
                        eventName: 'profile-scraped',
                        count: 1,
                    });


                    log.info(
                        `Successfully scraped profile: ` +
                        `${request.url} | ` +
                        `items=${results.length}`
                    );

                } catch (error) {

                    const message =
                        error?.message ??
                        String(error);


                    directFailedUrls.set(
                        request.url,
                        message
                    );


                    log.warning(
                        `Direct scraping failed: ` +
                        `${request.url} | ${message}`
                    );


                    throw error;
                }
            },


            async failedRequestHandler({
                request,
                log,
            }) {

                directFailedUrls.set(
                    request.url,
                    directFailedUrls.get(
                        request.url
                    ) ?? 'Page unreachable.'
                );


                log.warning(
                    `Direct request permanently failed: ` +
                    `${request.url}`
                );
            },
        });


    await crawler.run();
}


/*
|--------------------------------------------------------------------------
| Proxy crawler
|--------------------------------------------------------------------------
*/

async function runProxyCrawler(
    urlsToRetry
) {

    if (
        urlsToRetry.length === 0 ||
        !hasProxy
    ) {
        return;
    }


    const queue =
        await createQueue(
            urlsToRetry,
            `linkedin-proxy-${Date.now()}`
        );


    const crawler =
        new PuppeteerCrawler({

            requestQueue: queue,

            proxyConfiguration,

            launchContext: {

                launcher: puppeteer,

                launchOptions: {
                    headless: true,
                },
            },

            maxConcurrency,

            maxRequestRetries:
                maxProxiedRetries,

            requestHandlerTimeoutSecs,


            preNavigationHooks: [
                setupPage,
            ],


            async requestHandler({
                page,
                request,
                log,
                injectJQuery,
            }) {

                try {

                    const results =
                        await scrapeProfile({
                            page,
                            request,
                            log,
                            injectJQuery,
                            isProxyUsed: true,
                        });


                    successfulUrls.add(
                        request.url
                    );


                    /*
                     * Charge ONLY after successful
                     * Dataset insertion.
                     */

                    await Actor.charge({
                        eventName: 'profile-scraped',
                        count: 1,
                    });


                    log.info(
                        `Successfully scraped profile using proxy: ` +
                        `${request.url} | ` +
                        `items=${results.length}`
                    );

                } catch (error) {

                    log.warning(
                        `Proxy scraping failed: ` +
                        `${request.url} | ` +
                        `${error?.message ?? error}`
                    );

                    throw error;
                }
            },


            async failedRequestHandler({
                request,
                log,
                page,
            }) {

                if (
                    successfulUrls.has(
                        request.url
                    )
                ) {
                    return;
                }


                let note =
                    'Page unreachable through configured proxy.';


                try {

                    if (
                        page &&
                        isAuthWall(page.url())
                    ) {

                        note =
                            'Blocked by LinkedIn Authwall.';
                    }

                } catch {
                    // Ignore page inspection failure.
                }


                if (
                    !finalFailedUrls.has(
                        request.url
                    )
                ) {

                    finalFailedUrls.add(
                        request.url
                    );


                    await Actor.pushData({

                        url: request.url,

                        status: 'failed',

                        note,

                        isProxyUsed: true,
                    });
                }


                log.error(
                    `Proxy request permanently failed: ` +
                    `${request.url}`
                );
            },
        });


    await crawler.run();
}


/*
|--------------------------------------------------------------------------
| Write direct failures when proxy fallback isn't enabled
|--------------------------------------------------------------------------
*/

async function writeDirectFailures() {

    for (
        const [url, error] of directFailedUrls.entries()
    ) {

        if (
            successfulUrls.has(url) ||
            finalFailedUrls.has(url)
        ) {
            continue;
        }


        finalFailedUrls.add(url);


        await Actor.pushData({

            url,

            status: 'failed',

            note: error || 'Page unreachable.',

            isProxyUsed: false,
        });
    }
}


/*
|--------------------------------------------------------------------------
| Main
|--------------------------------------------------------------------------
*/

try {

    /*
     * Validate configuration.
     */

    if (
        !onlyProfileInfo &&
        !input.maxItems &&
        !input.onlyPostsNewerThan
    ) {

        throw new Error(
            'You must configure at least one limiting parameter: ' +
            'maxItems or onlyPostsNewerThan. ' +
            'Alternatively enable onlyProfileInfo.'
        );
    }


    if (
        useProxyOnlyAfterFail &&
        !hasProxy
    ) {

        throw new Error(
            'useProxyOnlyAfterFail is enabled but no proxy is configured.'
        );
    }


    console.log(
        '=========================================='
    );

    console.log(
        'LinkedIn Profile Posts Scraper'
    );

    console.log(
        `Profiles requested: ${urls.length}`
    );

    console.log(
        `Only profile info: ${onlyProfileInfo}`
    );

    console.log(
        `Max posts per profile: ${maxItems}`
    );

    console.log(
        `Proxy fallback: ${useProxyOnlyAfterFail}`
    );

    console.log(
        `Custom proxy configured: ${customProxyUrls.length > 0}`
    );

    console.log(
        '=========================================='
    );


    /*
     * STEP 1
     *
     * Direct scraping.
     */

    await runDirectCrawler();


    /*
     * STEP 2
     *
     * Retry only direct failures using proxy.
     */

    if (
        useProxyOnlyAfterFail &&
        hasProxy
    ) {

        const retryUrls =
            [...directFailedUrls.keys()]
                .filter(
                    url =>
                        !successfulUrls.has(url)
                );


        if (retryUrls.length > 0) {

            console.log(
                `Retrying ${retryUrls.length} profile(s) using proxy.`
            );


            await runProxyCrawler(
                retryUrls
            );
        }
    }


    /*
     * STEP 3
     *
     * If proxy fallback is disabled,
     * write final direct failures.
     */

    if (
        !useProxyOnlyAfterFail
    ) {

        await writeDirectFailures();
    }


    /*
     * If proxy was enabled but some URLs failed
     * direct + proxy, proxy crawler already writes
     * the final failure records.
     */


    console.log(
        '=========================================='
    );

    console.log(
        `Profiles requested: ${urls.length}`
    );

    console.log(
        `Profiles successful: ${successfulUrls.size}`
    );

    console.log(
        `Profiles failed: ${finalFailedUrls.size}`
    );

    console.log(
        '=========================================='
    );

} catch (error) {

    console.error(
        'Actor execution failed:',
        error
    );

    throw error;

} finally {

    await Actor.exit();
}