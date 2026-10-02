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
    throw new Error('At least one LinkedIn profile URL is required.');
}

const maxProfiles = Math.min(
    Math.max(Number(input.maxProfiles ?? startUrls.length), 1),
    100,
);

const urls = [...new Set(startUrls)].slice(0, maxProfiles);

const disableImagesStylesFonts =
    input.disableImagesStylesFonts !== false;

const useProxyOnlyAfterFail =
    input.useProxyOnlyAfterFail === true;

const proxyInput = input.proxy ?? {};

const useApifyProxy =
    proxyInput.useApifyProxy === true;

const customProxyUrls =
    Array.isArray(proxyInput.proxyUrls)
        ? proxyInput.proxyUrls.filter(Boolean)
        : [];

const hasConfiguredProxy =
    useApifyProxy || customProxyUrls.length > 0;

if (useProxyOnlyAfterFail && !hasConfiguredProxy) {
    throw new Error(
        'useProxyOnlyAfterFail is enabled, but no proxy is configured. ' +
        'Set proxy.useApifyProxy=true or provide proxy.proxyUrls.'
    );
}

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


/*
|--------------------------------------------------------------------------
| Result tracking
|--------------------------------------------------------------------------
*/

const failedDirectUrls = new Map();

const successfulUrls = new Set();

const failedUrls = new Set();


/*
|--------------------------------------------------------------------------
| Build Request Queue
|--------------------------------------------------------------------------
*/

async function createQueue(urlsToAdd, queueName) {

    const queue = await RequestQueue.open(queueName);

    for (const [index, url] of urlsToAdd.entries()) {

        await queue.addRequest({
            url,

            uniqueKey: `${queueName}-${index}-${url}`,

            userData: {
                profileIndex: index,
            },
        });
    }

    return queue;
}


/*
|--------------------------------------------------------------------------
| Create Proxy Configuration
|--------------------------------------------------------------------------
*/

let proxyConfiguration = null;

if (hasConfiguredProxy) {

    proxyConfiguration =
        await Actor.createProxyConfiguration({
            useApifyProxy,

            proxyUrls: customProxyUrls,
        });
}


/*
|--------------------------------------------------------------------------
| Common page setup
|--------------------------------------------------------------------------
*/

async function setupPage({ page }) {

    await page.setUserAgent(DEFAULT_USER_AGENT);

    if (!disableImagesStylesFonts) {
        return;
    }

    await page.setRequestInterception(true);

    page.on('request', async (request) => {

        const blockedTypes = [
            'stylesheet',
            'font',
            'image',
            'media',
        ];

        try {

            if (blockedTypes.includes(request.resourceType())) {

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
| Scrape one profile
|--------------------------------------------------------------------------
*/

async function scrapeProfile({
    page,
    request,
    log,
    pushData,
    injectJQuery,
    isProxyUsed,
}) {

    log.info(
        `Scraping LinkedIn profile: ${request.url} | proxy=${isProxyUsed}`
    );

    /*
     * Detect Authwall BEFORE scraper processing.
     */

    const currentUrl = page.url();

    if (currentUrl.includes(AUTH_WALL)) {

        throw new Error(
            'Blocked by LinkedIn Authwall.'
        );
    }


    /*
     * Give LinkedIn a moment to finish redirects.
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
     * Check again after navigation.
     */

    const finalUrl = page.url();

    if (finalUrl.includes(AUTH_WALL)) {

        throw new Error(
            'Blocked by LinkedIn Authwall.'
        );
    }


    /*
     * Inject jQuery used by the existing scraper.
     */

    await injectJQuery();


    /*
     * Existing scraper.
     */

    const scraper = new LinkedinPageScrapper(
        page,
        log,
        request,
        input,
        pushData,
        isProxyUsed,
    );


    const result = await scraper.process();


    if (!result) {

        throw new Error(
            'No data was extracted from the profile.'
        );
    }


    const results =
        Array.isArray(result)
            ? result
            : [result];


    /*
     * Only push actual successful results.
     */

    let pushed = 0;

    for (const item of results) {

        if (!item) {
            continue;
        }

        await pushData(item);

        pushed++;
    }


    if (pushed === 0) {

        throw new Error(
            'Scraper returned no valid output.'
        );
    }


    return pushed;
}


/*
|--------------------------------------------------------------------------
| Direct crawler
|--------------------------------------------------------------------------
*/

async function runDirectCrawler() {

    const directQueue = await createQueue(
        urls,
        `linkedin-direct-${Date.now()}`
    );


    const crawler = new PuppeteerCrawler({

        requestQueue: directQueue,

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
            pushData,
            injectJQuery,
        }) {

            try {

                await scrapeProfile({
                    page,
                    request,
                    log,
                    pushData,
                    injectJQuery,
                    isProxyUsed: false,
                });


                successfulUrls.add(request.url);


                /*
                 * Charge ONLY after successful scraping.
                 */

                await Actor.charge({
                    eventName: 'profile-scraped',
                    count: 1,
                });


                log.info(
                    `Successfully scraped profile: ${request.url}`
                );

            } catch (error) {

                /*
                 * Store the failure.
                 *
                 * We don't immediately push a failed result because
                 * Crawlee may retry this request.
                 */

                failedDirectUrls.set(
                    request.url,
                    error?.message ?? String(error)
                );


                log.warning(
                    `Direct scraping failed: ${request.url} | ` +
                    `${error?.message ?? error}`
                );


                throw error;
            }
        },


        async failedRequestHandler({
            request,
            log,
        }) {

            failedDirectUrls.set(
                request.url,
                failedDirectUrls.get(request.url)
                    ?? 'Page unreachable.'
            );


            log.warning(
                `Direct scraping permanently failed: ${request.url}`
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

async function runProxyCrawler(urlsToRetry) {

    if (
        urlsToRetry.length === 0 ||
        !hasConfiguredProxy
    ) {
        return;
    }


    console.log(
        `Starting proxy retry phase for ${urlsToRetry.length} profile(s).`
    );


    const proxyQueue = await createQueue(
        urlsToRetry,
        `linkedin-proxy-${Date.now()}`
    );


    const crawler = new PuppeteerCrawler({

        requestQueue: proxyQueue,

        /*
         * IMPORTANT:
         *
         * Proxy is configured on the crawler itself.
         * We don't dynamically modify proxyConfiguration from
         * failedRequestHandler.
         */

        proxyConfiguration,

        launchContext: {

            launcher: puppeteer,

            launchOptions: {
                headless: true,
            },
        },

        maxConcurrency,

        maxRequestRetries: maxProxiedRetries,

        requestHandlerTimeoutSecs,

        preNavigationHooks: [
            setupPage,
        ],


        async requestHandler({
            page,
            request,
            log,
            pushData,
            injectJQuery,
        }) {

            try {

                await scrapeProfile({
                    page,
                    request,
                    log,
                    pushData,
                    injectJQuery,
                    isProxyUsed: true,
                });


                successfulUrls.add(request.url);


                /*
                 * Charge only successful profile.
                 */

                await Actor.charge({
                    eventName: 'profile-scraped',
                    count: 1,
                });


                log.info(
                    `Successfully scraped profile using proxy: ${request.url}`
                );

            } catch (error) {

                log.warning(
                    `Proxy scraping failed: ${request.url} | ` +
                    `${error?.message ?? error}`
                );

                throw error;
            }
        },


        async failedRequestHandler({
            request,
            log,
            pushData,
            page,
        }) {

            if (successfulUrls.has(request.url)) {
                return;
            }


            let note =
                'Page unreachable through configured proxy.';


            /*
             * Detect Authwall.
             */

            try {

                const currentUrl =
                    page?.url?.() ?? '';

                if (currentUrl.includes(AUTH_WALL)) {

                    note =
                        'Blocked by LinkedIn Authwall.';
                }

            } catch {
                // Ignore page inspection errors.
            }


            /*
             * Save ONE final failure.
             */

            if (!failedUrls.has(request.url)) {

                failedUrls.add(request.url);


                await pushData({

                    url: request.url,

                    status: 'failed',

                    note,

                    isProxyUsed: true,
                });
            }


            log.error(
                `Request failed after proxy retries: ${request.url}`
            );
        },
    });


    await crawler.run();
}


/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

try {

    /*
     * STEP 1
     *
     * Try all profiles directly.
     */

    console.log(
        `Starting direct scraping for ${urls.length} profile(s).`
    );


    await runDirectCrawler();


    /*
     * STEP 2
     *
     * Retry only profiles that failed direct scraping.
     */

    if (
        useProxyOnlyAfterFail &&
        hasConfiguredProxy &&
        failedDirectUrls.size > 0
    ) {

        const retryUrls = [
            ...failedDirectUrls.keys()
        ].filter(
            url => !successfulUrls.has(url)
        );


        console.log(
            `Direct scraping failed for ${retryUrls.length} profile(s). ` +
            `Starting proxy retry phase.`
        );


        await runProxyCrawler(
            retryUrls
        );
    }


    /*
     * STEP 3
     *
     * If proxy mode isn't enabled, write the direct failures.
     */

    if (
        !useProxyOnlyAfterFail &&
        failedDirectUrls.size > 0
    ) {

        const directFailures = [
            ...failedDirectUrls.entries()
        ];


        for (
            const [url, error] of directFailures
        ) {

            if (successfulUrls.has(url)) {
                continue;
            }


            if (failedUrls.has(url)) {
                continue;
            }


            failedUrls.add(url);


            await Actor.pushData({

                url,

                status: 'failed',

                note: error || 'Page unreachable.',

                isProxyUsed: false,
            });
        }
    }


    /*
     * Summary
     */

    console.log('----------------------------------');

    console.log(
        `Profiles requested: ${urls.length}`
    );

    console.log(
        `Profiles successful: ${successfulUrls.size}`
    );

    console.log(
        `Profiles failed: ${failedUrls.size}`
    );

    console.log('----------------------------------');


} catch (error) {

    console.error(
        'Actor execution failed:',
        error
    );

    throw error;

} finally {

    await Actor.exit();
}