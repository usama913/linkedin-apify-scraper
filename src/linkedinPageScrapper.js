import ArticleProvider from './articleProvider.js';

export default class LinkedinPageScrapper {
    constructor({
        page,
        request,
        log,
        config = {},
        isProxyUsed = false,
    }) {
        this.page = page;
        this.request = request;
        this.log = log;

        this.config = {
            maxItems: config.maxItems ?? 20,
            onlyProfileInfo: config.onlyProfileInfo ?? false,
            includeProfileInfo: config.includeProfileInfo ?? true,
        };

        this.isProxyUsed = isProxyUsed;
    }

    // --------------------------------------------------------
    // Main processing
    // --------------------------------------------------------

    async process() {
        const url = this.request.url;

        if (!url) {
            throw new Error('LinkedIn URL is missing.');
        }

        this.log.info(`Opening LinkedIn URL: ${url}`);

        await this._loginPage();

        await this._closeSignInModal();

        await this._overrideDelayedImageAttributes();

        if (await this._pageNotFound()) {
            throw new Error(
                `LinkedIn page not found: ${url}`
            );
        }

        // ----------------------------------------------------
        // IMPORTANT:
        // profileType is calculated in Node context.
        // Do NOT call this._detectProfileType inside
        // page.evaluate().
        // ----------------------------------------------------

        const profileType = this._detectProfileType(url);

        const profileInfo =
            await this._getProfileInfo(profileType);

        if (this.config.onlyProfileInfo) {
            return [
                {
                    ...profileInfo,
                    isProxyUsed: this.isProxyUsed,
                },
            ];
        }

        const articleProvider = new ArticleProvider({
            page: this.page,
            log: this.log,
        });

        const articles = [];

        for (
            let index = 0;
            index < this.config.maxItems;
            index++
        ) {
            try {
                const article =
                    await articleProvider.getArticle(index);

                if (!article) {
                    break;
                }

                // Avoid empty articles.
                if (
                    !article.postId &&
                    !article.postUrl &&
                    !article.postText
                ) {
                    continue;
                }

                articles.push(article);
            } catch (error) {
                this.log.warning(
                    `Unable to extract article ${index}: ${error.message}`
                );
            }
        }

        // ----------------------------------------------------
        // If no posts were found, still return profile info.
        // ----------------------------------------------------

        if (articles.length === 0) {
            return [
                {
                    ...profileInfo,
                    isProxyUsed: this.isProxyUsed,
                },
            ];
        }

        // ----------------------------------------------------
        // Merge profile information into every post.
        // ----------------------------------------------------

        return articles.map(article => {
            if (!this.config.includeProfileInfo) {
                return {
                    ...article,
                    isProxyUsed: this.isProxyUsed,
                };
            }

            return {
                ...profileInfo,
                ...article,
                isProxyUsed: this.isProxyUsed,
            };
        });
    }

    // --------------------------------------------------------
    // Profile type
    // --------------------------------------------------------

    _detectProfileType(url) {
        if (!url) {
            return 'unknown';
        }

        const normalizedUrl = url.toLowerCase();

        if (
            normalizedUrl.includes('/company/') ||
            normalizedUrl.includes('/organization-guest/company/')
        ) {
            return 'company';
        }

        if (
            normalizedUrl.includes('/school/') ||
            normalizedUrl.includes('/organization-guest/school/')
        ) {
            return 'school';
        }

        if (
            normalizedUrl.includes('/showcase/') ||
            normalizedUrl.includes('/organization-guest/showcase/')
        ) {
            return 'showcase';
        }

        if (
            normalizedUrl.includes('/in/') ||
            normalizedUrl.includes('/organization-guest/in/')
        ) {
            return 'person';
        }

        return 'unknown';
    }

    // --------------------------------------------------------
    // Profile information
    // --------------------------------------------------------

    async _getProfileInfo(profileType) {
        const url = this.request.url;

        return await this.page.evaluate(
            (url, isProxyUsed, profileType) => {
                const cleanText = value => {
                    if (!value) {
                        return undefined;
                    }

                    const text =
                        String(value)
                            .replace(/\s+/g, ' ')
                            .trim();

                    return text || undefined;
                };

                const getText = selectors => {
                    for (const selector of selectors) {
                        const element =
                            document.querySelector(selector);

                        if (element) {
                            const text =
                                cleanText(
                                    element.innerText ||
                                    element.textContent
                                );

                            if (text) {
                                return text;
                            }
                        }
                    }

                    return undefined;
                };

                const getAttribute = (
                    selectors,
                    attribute
                ) => {
                    for (const selector of selectors) {
                        const element =
                            document.querySelector(selector);

                        if (element) {
                            const value =
                                element.getAttribute(attribute);

                            if (value) {
                                return value.trim();
                            }
                        }
                    }

                    return undefined;
                };

                const getFollowersCount = () => {
                    const bodyText =
                        document.body?.innerText || '';

                    const match =
                        bodyText.match(
                            /([\d,.]+)\s*(followers|follower)/i
                        );

                    if (!match) {
                        return undefined;
                    }

                    const raw =
                        match[1]
                            .replace(/,/g, '')
                            .replace(/\./g, '');

                    const parsed =
                        Number.parseInt(raw, 10);

                    return Number.isFinite(parsed)
                        ? parsed
                        : undefined;
                };

                const profileName =
                    getText([
                        'h1',
                        '.org-top-card-summary__title',
                        '.org-top-card-summary-info-list__info-item',
                        '.pv-text-details__left-panel h1',
                        '.text-heading-xlarge',
                    ]);

                const profileTitle =
                    getText([
                        '.org-top-card-summary__tagline',
                        '.org-top-card-summary-info-list__info-item',
                        '.text-body-medium',
                        '.pv-text-details__left-panel .text-body-medium',
                    ]);

                const profileDescription =
                    getText([
                        '.org-about-us-organization-description__text',
                        '.break-words.white-space-pre-wrap',
                        '.org-about-company-module__description',
                        '.about-us__description',
                    ]);

                let companyUrl =
                    getAttribute(
                        [
                            'a[data-tracking-control-name*="website"]',
                            'a[href*="http"]',
                            '.org-about-company-module__website a',
                        ],
                        'href'
                    );

                if (
                    companyUrl &&
                    companyUrl.startsWith('/')
                ) {
                    companyUrl =
                        `https://www.linkedin.com${companyUrl}`;
                }

                let companySize =
                    getText([
                        '.org-about-company-module__company-size-definition-text',
                        '.org-about-company-module__company-size',
                    ]);

                if (!companySize) {
                    const bodyText =
                        document.body?.innerText || '';

                    const sizeMatch =
                        bodyText.match(
                            /(\d[\d,]*\s*-\s*\d[\d,]*\s*employees)/i
                        );

                    if (sizeMatch) {
                        companySize =
                            cleanText(sizeMatch[1]);
                    }
                }

                const followersCount =
                    getFollowersCount();

                return {
                    profileUrl: url,
                    profileType,
                    profileName,
                    profileTitle,
                    profileDescription,
                    companyUrl,
                    companySize,
                    followersCount,
                    isProxyUsed,
                };
            },
            url,
            this.isProxyUsed,
            profileType
        );
    }

    // --------------------------------------------------------
    // Authentication / auth-wall detection
    // --------------------------------------------------------

    async _loginPage() {
        // Native delay. Puppeteer v25 no longer provides
        // page.waitForTimeout().
        await this._sleep(1500);

        const currentUrl =
            this.page.url().toLowerCase();

        if (this._isAuthenticationUrl(currentUrl)) {
            throw new Error(
                `LinkedIn authentication wall detected: ${currentUrl}`
            );
        }

        // LinkedIn can sometimes render an auth wall without
        // changing the URL. Check the page content as well.
        const authWallDetected =
            await this.page.evaluate(() => {
                const bodyText =
                    document.body?.innerText?.toLowerCase() || '';

                return (
                    bodyText.includes('sign in to linkedin') ||
                    bodyText.includes('join linkedin') ||
                    bodyText.includes('sign up on linkedin') ||
                    bodyText.includes('authentication required') ||
                    bodyText.includes('please sign in')
                );
            }).catch(() => false);

        if (authWallDetected) {
            throw new Error(
                `LinkedIn authentication wall detected: ${currentUrl}`
            );
        }
    }

    _isAuthenticationUrl(url) {
        if (!url) {
            return false;
        }

        const normalizedUrl =
            url.toLowerCase();

        return (
            normalizedUrl.includes('/login') ||
            normalizedUrl.includes('/checkpoint') ||
            normalizedUrl.includes('/authwall')
        );
    }

    // --------------------------------------------------------
    // Sleep helper
    // --------------------------------------------------------

    async _sleep(milliseconds) {
        await new Promise(resolve =>
            setTimeout(resolve, milliseconds)
        );
    }

    // --------------------------------------------------------
    // Page not found
    // --------------------------------------------------------

    async _pageNotFound() {
        try {
            const result =
                await this.page.evaluate(() => {
                    const bodyText =
                        document.body?.innerText || '';

                    const text =
                        bodyText.toLowerCase();

                    return (
                        text.includes('page not found') ||
                        text.includes('this page doesn’t exist') ||
                        text.includes("this page doesn't exist") ||
                        text.includes('profile not found') ||
                        text.includes('something went wrong')
                    );
                });

            return result;
        } catch {
            return false;
        }
    }

    // --------------------------------------------------------
    // Delayed images
    // --------------------------------------------------------

    async _overrideDelayedImageAttributes() {
        try {
            await this.page.evaluate(() => {
                const images =
                    document.querySelectorAll('img');

                for (const image of images) {
                    const dataSrc =
                        image.getAttribute('data-src');

                    const lazySrc =
                        image.getAttribute('data-lazy-src');

                    const source =
                        dataSrc || lazySrc;

                    if (
                        source &&
                        !image.getAttribute('src')
                    ) {
                        image.setAttribute(
                            'src',
                            source
                        );
                    }
                }
            });
        } catch {
            // Intentionally ignored.
        }
    }

    // --------------------------------------------------------
    // Close LinkedIn sign-in modal
    // --------------------------------------------------------

    async _closeSignInModal() {
        try {
            const selectors = [
                'button[aria-label="Dismiss"]',
                'button[aria-label="Close"]',
                '.artdeco-modal__dismiss',
                '.modal-close-button',
            ];

            for (const selector of selectors) {
                const button =
                    await this.page.$(selector);

                if (button) {
                    await button.click().catch(() => {});

                    await this._sleep(300);

                    break;
                }
            }
        } catch {
            // Modal is optional.
        }
    }
}