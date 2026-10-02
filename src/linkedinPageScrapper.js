import { ArticleProvider } from './articleProvider.js';

export class LinkedinPageScrapper {

    constructor(
        page,
        log,
        request,
        actorInput,
        isProxyUsed
    ) {

        this.page = page;

        this.log = log;

        this.request = request;

        this.config = actorInput;

        this.isProxyUsed = isProxyUsed;
    }


    async process() {

        /*
         * Validate URL.
         */

        if (
            !this._validateLinkedInURL(
                this.request.url
            )
        ) {

            return [{
                url: this.request.url,

                status: 'failed',

                note:
                    'Input URL does not match LinkedIn URL format.',

                isProxyUsed:
                    this.isProxyUsed,
            }];
        }


        this.log.info(
            `Starting scraping: ${this.request.url}`
        );


        if (this.config.maxItems) {

            this.log.info(
                `MaxItems: ${this.config.maxItems}`
            );
        }


        if (this.config.onlyPostsNewerThan) {

            this.log.info(
                `OnlyPostsNewerThan: ` +
                `${this.config.onlyPostsNewerThan}`
            );
        }


        /*
         * Page not found.
         */

        if (
            await this._pageNotFound()
        ) {

            return [{
                url: this.request.url,

                status: 'failed',

                note: 'Page not found.',

                isProxyUsed:
                    this.isProxyUsed,
            }];
        }


        /*
         * Prepare page.
         */

        await this._overrideDelayedImageAttributes();

        await this._closeSignInModal();


        /*
         * Make sure LinkedIn main content exists.
         */

        try {

            const isElementPresent =
                await this.page.evaluate(() => {

                    return (
                        document.querySelector(
                            '#main-content'
                        ) !== null
                    );
                });


            if (!isElementPresent) {

                await this.page.waitForSelector(
                    '#main-content',
                    {
                        timeout: 5000,
                    }
                );
            }

        } catch (error) {

            if (
                await this._loginPage()
            ) {

                return [{
                    url: this.request.url,

                    status: 'failed',

                    note: 'Login required.',

                    isProxyUsed:
                        this.isProxyUsed,
                }];
            }


            this.log.error(
                error.message
            );

            throw error;
        }


        /*
         * Profile information.
         */

        const profileInfo =
            await this._getProfileInfo();


        /*
         * Profile-only mode.
         */

        if (
            this.config.onlyProfileInfo
        ) {

            return [
                profileInfo
            ];
        }


        /*
         * Posts mode.
         */

        const result = [];

        const articleProvider =
            new ArticleProvider(
                this.page
            );


        /*
         * LinkedIn can have pinned posts.
         */

        const maxPinnedPosts = 5;


        let index = 0;


        const maxItems =
            Number(this.config.maxItems ?? 10);


        const pageUrl =
            this.page.url();


        const profile =
            this.extractProfileIdentifier(
                pageUrl
            );


        while (
            result.length < maxItems
        ) {

            try {

                const article =
                    await articleProvider.getArticle(
                        index
                    );


                /*
                 * No more posts.
                 */

                if (!article) {

                    break;
                }


                /*
                 * Make sure the post belongs to
                 * the requested profile/company.
                 *
                 * Some LinkedIn pages can expose
                 * unrelated/reposted content.
                 */

                if (
                    profile &&
                    article.postUrl &&
                    !article.postUrl.includes(
                        profile
                    )
                ) {

                    break;
                }


                /*
                 * Date filtering.
                 */

                const minDate =
                    this.config.onlyPostsNewerThan;


                if (
                    minDate &&
                    article.postDate
                ) {

                    const articleDate =
                        new Date(
                            article.postDate
                        );

                    const minimumDate =
                        new Date(
                            minDate
                        );


                    if (
                        !Number.isNaN(
                            articleDate.getTime()
                        ) &&
                        !Number.isNaN(
                            minimumDate.getTime()
                        ) &&
                        articleDate < minimumDate
                    ) {

                        /*
                         * Skip old pinned posts.
                         */

                        if (
                            result.length <
                            index - maxPinnedPosts
                        ) {

                            this.log.info(
                                `Actor ends work due to date filter: ${minDate}`
                            );

                            break;
                        }


                        index++;

                        continue;
                    }
                }


                /*
                 * Add profile information to
                 * every post if requested.
                 */

                let outputItem;


                if (
                    this.config.includeProfileInfo
                ) {

                    outputItem = {
                        ...profileInfo,
                        ...article,
                    };

                } else {

                    outputItem = {
                        ...article,

                        url:
                            this.request.url,

                        isProxyUsed:
                            this.isProxyUsed,
                    };
                }


                /*
                 * Ensure proxy information exists.
                 */

                outputItem.isProxyUsed =
                    this.isProxyUsed;


                /*
                 * Add result to memory.
                 *
                 * DO NOT push to Dataset here.
                 * main.js handles Dataset writes.
                 */

                result.push(
                    outputItem
                );


                this.log.info(
                    `Article #${result.length} scraped.`
                );


                index++;


                await this._overrideDelayedImageAttributes();

            } catch (error) {

                this.log.error(
                    `Article scraping error: ` +
                    `${error.message}`
                );

                break;
            }
        }


        /*
         * If no posts were found but profile
         * information was requested, return
         * profile information.
         */

        if (
            result.length === 0 &&
            this.config.includeProfileInfo
        ) {

            return [
                profileInfo
            ];
        }


        if (
            result.length === maxItems
        ) {

            this.log.info(
                `Actor ends work due to MaxItems limit: ${maxItems}`
            );
        }


        return result;
    }


    /*
     |--------------------------------------------------------------------------
     | Extract LinkedIn profile/company identifier
     |--------------------------------------------------------------------------
     */

    extractProfileIdentifier(url) {

        try {

            const cleanUrl =
                url.split('?')[0]
                    .replace(/\/+$/, '');


            const parts =
                cleanUrl.split('/');


            return parts[
                parts.length - 1
            ] || null;

        } catch {

            return null;
        }
    }


    /*
     |--------------------------------------------------------------------------
     | Page not found
     |--------------------------------------------------------------------------
     */

    async _pageNotFound() {

        return await this.page.evaluate(() => {

            const pageNotFound =
                document.getElementsByClassName(
                    'not-found-404'
                );

            return (
                pageNotFound.length > 0
            );
        });
    }


    /*
     |--------------------------------------------------------------------------
     | Login page detection
     |--------------------------------------------------------------------------
     */

    async _loginPage() {

        return await this.page.evaluate(() => {

            const mainContent =
                document.getElementById(
                    'main-content'
                );


            if (mainContent) {

                return (
                    mainContent.getElementsByClassName(
                        'join-form'
                    ).length > 0
                );
            }


            const cardLayout =
                document.getElementsByClassName(
                    'card-layout'
                );


            if (
                cardLayout.length > 0
            ) {

                return (
                    cardLayout[0]
                        .getElementsByClassName(
                            'login__form'
                        ).length > 0
                );
            }


            return false;
        });
    }


    /*
     |--------------------------------------------------------------------------
     | LinkedIn delayed images
     |--------------------------------------------------------------------------
     */

    async _overrideDelayedImageAttributes() {

        await this.page.evaluate(() => {

            const delayedElements =
                document.querySelectorAll(
                    '[data-delayed-url]'
                );


            delayedElements.forEach(
                element => {

                    const url =
                        element.getAttribute(
                            'data-delayed-url'
                        );


                    if (url) {

                        element.setAttribute(
                            'data-delayed-url_custom',
                            url
                        );
                    }
                }
            );
        });
    }


    /*
     |--------------------------------------------------------------------------
     | Profile information
     |--------------------------------------------------------------------------
     */

    async _getProfileInfo() {

        const profileInfo =
            await this.page.evaluate(
                (url, isProxyUsed) => {

                    const mainContent =
                        document.getElementById(
                            'main-content'
                        );


                    if (!mainContent) {

                        throw new Error(
                            'LinkedIn main content not found.'
                        );
                    }


                    /*
                     * Profile container.
                     */

                    const profileInfoContainer =
                        mainContent
                            .getElementsByClassName(
                                'top-card-layout__entity-info-container'
                            )[0];


                    /*
                     * Profile name.
                     */

                    let profileName = null;


                    if (
                        profileInfoContainer
                    ) {

                        const h1 =
                            profileInfoContainer
                                .getElementsByTagName(
                                    'h1'
                                )[0];


                        if (h1) {

                            profileName =
                                h1.innerText?.trim() ||
                                null;
                        }
                    }


                    /*
                     * Profile title.
                     */

                    let profileTitle = null;


                    const h2 =
                        mainContent
                            .getElementsByTagName(
                                'h2'
                            )[0];


                    if (h2) {

                        profileTitle =
                            h2.innerText?.trim() ||
                            null;
                    }


                    /*
                     * Description.
                     */

                    let profileDescription =
                        null;


                    const aboutDescription =
                        mainContent.querySelector(
                            "[data-test-id='about-us__description']"
                        );


                    if (
                        aboutDescription
                    ) {

                        profileDescription =
                            aboutDescription.innerText?.trim() ||
                            null;
                    }


                    /*
                     * Company website.
                     */

                    let companyUrl =
                        null;


                    const aboutWebsite =
                        mainContent.querySelector(
                            "[data-tracking-control-name='about_website']"
                        );


                    if (
                        aboutWebsite
                    ) {

                        companyUrl =
                            aboutWebsite.innerText?.trim() ||
                            null;
                    }


                    /*
                     * Company size.
                     */

                    let companySize =
                        null;


                    const aboutUsSize =
                        mainContent.querySelector(
                            "[data-test-id='about-us__size']"
                        );


                    if (
                        aboutUsSize &&
                        aboutUsSize.children.length > 1
                    ) {

                        companySize =
                            aboutUsSize
                                .children[1]
                                .innerText
                                ?.trim() ||
                            null;
                    }


                    /*
                     * Followers.
                     */

                    const getFollowersCount = () => {

                        const meta =
                            document.querySelector(
                                'meta[name="description"]'
                            );


                        if (!meta) {
                            return null;
                        }


                        const content =
                            meta.getAttribute(
                                'content'
                            );


                        if (!content) {
                            return null;
                        }


                        const parts =
                            content.split('|');


                        if (
                            parts.length < 2
                        ) {

                            return null;
                        }


                        const regex =
                            /(\d[\d,\s]*)+/;


                        const match =
                            parts[1].match(
                                regex
                            );


                        if (!match) {
                            return null;
                        }


                        const number =
                            parseInt(
                                match[0]
                                    .replace(/,/g, '')
                                    .trim(),
                                10
                            );


                        return Number.isFinite(
                            number
                        )
                            ? number
                            : null;
                    };


                    return {

                        url,

                        profileName,

                        profileTitle,

                        profileDescription,

                        companyUrl,

                        companySize,

                        followersCount:
                            getFollowersCount(),

                        isProxyUsed,
                    };

                },

                this.request.url,

                this.isProxyUsed
            );


        return profileInfo;
    }


    /*
     |--------------------------------------------------------------------------
     | Close LinkedIn sign-in modal
     |--------------------------------------------------------------------------
     */

    async _closeSignInModal() {

        await this.page.evaluate(() => {

            const dismissButton =
                document.getElementsByClassName(
                    'contextual-sign-in-modal__modal-dismiss'
                )[0];


            if (dismissButton) {

                dismissButton.click();
            }
        });
    }


    /*
     |--------------------------------------------------------------------------
     | URL validation
     |--------------------------------------------------------------------------
     */

    _validateLinkedInURL(input) {

        if (!input) {
            return false;
        }


        const regex =
            /^https:\/\/[^/]*linkedin\.com\//i;


        return regex.test(
            input
        );
    }
}