import { ArticleProvider } from "./articleProvider.js";

export class LinkedinPageScrapper 
{

    constructor(page, log, request, actorInput, pushData, isProxyUsed) 
    {
        this.page = page;
        this.log = log;
        this.request = request;
        this.config = actorInput;
        this.pushData = pushData;
        this.isProxyUsed = isProxyUsed;
    }

    async process() 
    {        

        if(!this._validateLinkedInURL(this.request.url)) 
        {
            return {
                url: this.request.url,
                note: `Input url is not matching regular expression...`,
                isProxyUsed: this.isProxyUsed
            };
        }

        this.log.info('Starting scraping: ' + this.request.url);
        if(this.config.maxItems) 
        {
            this.log.info('MaxItems: ' + this.config.maxItems);
        }

        if(this.config.onlyPostsNewerThan) 
        {
            this.log.info('OnlyPostsNewerThan: ' + this.config.onlyPostsNewerThan);
        }

        if(await this._pageNotFound()) 
        {
            return {
                url: this.request.url,
                note: `Page not found.`,
                isProxyUsed: this.isProxyUsed
            };
        }

        await this._overrideDelayedImageAttributes();
        await this._closeSignInModal();
            
        try 
        {
            const isElementPresent = await this.page.evaluate(() => {
                return document.querySelector('#main-content') !== null;
            });

            if(!isElementPresent) 
            {
                await this.page.waitForSelector('#main-content', { timeout: 4000 });
            }
        }
        catch(e)
        {
            if(await this._loginPage()) 
            {
                return {
                    url: this.request.url,
                    note: `Login required.`,
                    isProxyUsed: this.isProxyUsed
                };
            }
            
            this.log.error(e.message);
            throw e;
        }
        
        let profileInfo = null;
        profileInfo = await this._getProfileInfo();

        if(this.config.onlyProfileInfo) 
        {
            return [profileInfo];
        }
        const result = [];
        const articleProvider = new ArticleProvider(this.page);

        const maxPinnedPosts = 5;
        let index = 0;
        const maxItems = this.config.maxItems || 1000;
        const pageUrl = this.page.url();
        const splittedUrl = pageUrl.split('/');
        const profile = splittedUrl[splittedUrl.length - 1];

        while(result.length < maxItems) 
        {
            try{
                let article = await articleProvider.getArticle(index);

                if(!article) break;

                if(!article.postUrl.includes(profile)) break;

                const minDate = this.config.onlyPostsNewerThan;
                if(minDate && new Date(article.postDate) < new Date(minDate)) 
                {           
                    if(result.length < index - maxPinnedPosts) // Skipping up to {maxPinnedPosts} pinned posts, to not stop scraping if pinned posts are older then minDate 
                    {
                        this.log.info(`Actor ends work due to date filter: ${minDate}`);
                        break;  
                    }
                    index++;
                    continue;
                }
    
                if(this.config.includeProfileInfo) 
                {
                    article = {...profileInfo, ...article};
                }
                else 
                {
                    article.isProxyUsed = this.isProxyUsed;
                }

                this.log.info(`Article #${result.length+1} scraped.`);

                result.push(article);
                index++;
                await this._overrideDelayedImageAttributes();
            }
            catch(e) 
            {
                this.log.error(e.message);
                break;
            }
        }

        if(result.length === 0 && this.config.includeProfileInfo) 
        {
            return [profileInfo];
        }

        if(result.length === maxItems) 
        {
            this.log.info(`Actor ends work due to MaxItems limit: ${maxItems}`);
        }

        return result;
    }

    async _pageNotFound() 
    {
        return await this.page.evaluate(() => {
            const pageNotFound = document.getElementsByClassName("not-found-404");
            return pageNotFound.length > 0;
        });
    }

    async _loginPage() 
    {
        return await this.page.evaluate(() => {            
            const mainContent = document.getElementById("main-content");
            if(mainContent) 
            {
                return mainContent.getElementsByClassName("join-form").length > 0;
            }

            const cardLayout = document.getElementsByClassName("card-layout");
            if(cardLayout.length > 0) 
            {
                return cardLayout[0].getElementsByClassName("login__form").length > 0;
            }

            return false;
        });
    }

    async _overrideDelayedImageAttributes  () 
     {
        await this.page.evaluate(() => {
            const delayedElements = document.querySelectorAll('[data-delayed-url]');
            delayedElements.forEach(element => {
                const url = element.getAttribute('data-delayed-url');
                element.setAttribute('data-delayed-url_custom', url);
            });
        });
    };

    async _getProfileInfo() 
    {
        const profileInfo = await this.page.evaluate((url, isProxyUsed) => {
            const mainContent = document.getElementById("main-content");
            const profileInfoContainer = mainContent.getElementsByClassName("top-card-layout__entity-info-container")[0];
            const profileName = profileInfoContainer.getElementsByTagName("h1")[0].innerText;
            const profileTitle = mainContent.getElementsByTagName("h2")[0].innerText;

            let profileDescription = null;
            const aboutUsDescription = $(mainContent).find("[data-test-id='about-us__description']");
            if(aboutUsDescription.length > 0) 
            {
                profileDescription = aboutUsDescription[0].innerText;
            }
            
            let companyUrl = null;      
            const aboutWebsite = $(mainContent).find("[data-tracking-control-name='about_website']");
            if(aboutWebsite.length > 0) 
            {
                companyUrl = aboutWebsite[0].innerText;

                if(companyUrl) 
                {
                    companyUrl = companyUrl.trim()
                }
            }
     
            let companySize = null;
            const aboutUsSize = $(mainContent).find("[data-test-id='about-us__size']");
            if(aboutUsSize.length > 0 && aboutUsSize.children().length > 1) 
            {
                companySize = $(mainContent).find("[data-test-id='about-us__size']").children()[1].innerText;
            }

            const getFollowersCount = () => {
                const followersCountContent = document.querySelector('meta[name="description"]').content;
                if(!followersCountContent) 
                {
                    return null;
                }

                const followersCountParts = followersCountContent.split('|');
                const regex = /(\d+[,\s]*)+/;
                const match = followersCountParts[1].match(regex);
                if(match) 
                {
                    const result = match[0].replace(/[,]+/g, "").trim();
                    return parseInt(result);
                }
            };
                    
            const fullInfo = {
                url,
                profileName,
                profileTitle,
                profileDescription,
                companyUrl,
                companySize,
                followersCount: getFollowersCount(),
                isProxyUsed
            };

            return fullInfo;
        }, this.request.url, this.isProxyUsed);
        
        return profileInfo;
    }

    async _closeSignInModal() 
    {
        await this.page.evaluate(() => {
            const dismissButton = document.getElementsByClassName('contextual-sign-in-modal__modal-dismiss')[0];
            if(dismissButton) 
            {
                dismissButton.click();
            }
        });
    }

    _validateLinkedInURL(input) 
    {
        try {
            const url = new URL(input);
            return url.protocol === 'https:'
                && (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'));
        } catch {
            return false;
        }
    }
}