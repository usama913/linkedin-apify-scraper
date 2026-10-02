export class ArticleProvider {

    constructor(page) 
    {
        this.page = page;
    }

    async getArticle(index) 
    {
        const article = await this.page.evaluate(async (articleIndex) => 
            {
                const mainContent = document.getElementById("main-content");
    
                const waitFor = (delay) => 
                {
                    return new Promise(resolve => setTimeout(resolve, delay));
                }
    
                const getArticles = () => 
                {
                    const updatesList = mainContent.getElementsByClassName('updates__list')[0];
                    if(!updatesList) 
                    {
                        return [];
                    }

                    return Array.from(updatesList.children).filter(child => child.tagName === 'LI');
                };
    
                const retryScrollIntoArticle = async (article) => 
                {
                    $("html, body").animate({ scrollTop: 0 }, 1000);
                    await waitFor(1000);
                    article.scrollIntoView();
                }
    
                const getDate = (postId) =>
                {
                    const unixTimestamp = extractUnixTimestamp(postId);
                    const humanDateFormat = unixTimestampToHumanDate(unixTimestamp);
                    return humanDateFormat;
                }
    
                const extractUnixTimestamp = (postId) =>
                {
                    // BigInt needed as we need to treat postId as 64 bit decimal. This reduces browser support.
                    const asBinary = BigInt(postId).toString(2);
                    const first41Chars = asBinary.slice(0, 41);
                    const timestamp = parseInt(first41Chars, 2);
                    return timestamp;
                }
            
                const unixTimestampToHumanDate = (timestamp) => 
                {
                    const dateObject = new Date(timestamp);
                    const humanDateFormat = dateObject.toISOString();
                    return humanDateFormat;
                }
    
                const getImageUrl = async (article) =>
                {
                    const getSrc = (selector) => 
                    {
                        const image = $(article).find(selector)[0].children[0];
                        const src = image.getAttribute("data-delayed-url_custom") || image.src;
                        return src;
                    }

                    const articleSelector = "[data-test-id='article-content']";
                    const articleContent = $(article).find(articleSelector);
                    if(articleContent.length > 0) 
                    {
                        return getSrc(articleSelector);
                    }
            
                    const staticImageSelector = "[data-test-id='feed-images-content__list-item'";
                    const staticImage = $(article).find(staticImageSelector);
                    if(staticImage.length > 0) 
                    {
                        return getSrc(staticImageSelector);
                    }
            
                    const iFrame = $(article).find("[data-id='feed-paginated-document-content']");
                    if(iFrame.length > 0)
                    {
                        const configString = iFrame[0].getAttribute("data-native-document-config");
                        if(configString) 
                        {
                            const config = JSON.parse(configString);
                            return config.doc.coverPages[0].config.src;
                        }
                    }
            
                    const videoContentSelector = "[data-test-id='feed-live-video-content']";
                    const videoContent = $(article).find(videoContentSelector);
                    if(videoContent.length > 0) 
                    {
                        return getSrc(videoContentSelector);
                    }
            
                    const video = article.getElementsByClassName("vjs-tech");
                    if(video.length > 0) 
                    {
                        const poster = video[0].getAttribute("poster");
                        const posterUrl = video[0].getAttribute("data-poster-url");
                        return poster || posterUrl;
                    }
            
                    return null;
                }
            
                const getExternalVideoUrl = async (article) =>
                {
                    const externalVideo = $(article).find("[data-test-id='ingested-content-summary-external-video-content']");
                    if(externalVideo.length > 0) 
                    {         
                        const getSrc = () => $(article).find("[data-test-id='ingested-content-summary-external-video-content']")[0].children[0].getAttribute("src");
                        await waitFor(1000);
    
                        return getSrc();
                    }
                    
                    return null;
                }

                const getRepostInfo = (article) => 
                {
                    const repostInfoElement = $(article).find(".mx-main-feed-card-no-gutter");

                    if(repostInfoElement.length === 0) 
                    {
                        return null;
                    }

                    const repostedProfileNameElement = $(article).find("[data-tracking-control-name='organization_guest_main-feed-card_feed-actor-name']");
                    if(repostedProfileNameElement.length > 0) 
                    {
                        const repostedProfileName = repostedProfileNameElement[0].innerText;
                        const repostedProfileUrl = repostedProfileNameElement[0].href.split('?')[0];
                        
                        return {
                            profileName: repostedProfileName,
                            profileUrl: repostedProfileUrl
                        };
                    }

                    return null;
                }
    
                const getPostData = async (article) =>
                {
                    const postUrl = $(article).find("[data-id='main-feed-card__full-link']")[0].href;
                    const articleElement = $(article).find("[data-id='main-feed-card']")[0];
                    const postId = articleElement.getAttribute('data-activity-urn').split(':')[3];
    
                    const postText = $(articleElement).find("[data-test-id='main-feed-activity-card__commentary']")[0].innerText;
                    const postLikesElements = $(articleElement).find("[data-test-id='social-actions__reaction-count']");
                    let postLikes = null;
                    if(postLikesElements.length > 0) 
                    {
                        try 
                        {
                            postLikes = parseInt(postLikesElements[0].innerText.trim());
                        }
                        catch 
                        {
                            postLikes = null;
                        }
                    }
    
                    const postCommentsCountElements = $(articleElement).find("[data-id='social-actions__comments']");
                    let postCommentsCount = null;
                    if(postCommentsCountElements.length > 0) 
                    {
                        try 
                        {
                            postCommentsCount = parseInt(postCommentsCountElements[0].getAttribute("data-num-comments"));
                        }
                        catch 
                        {
                            postCommentsCount = null;
                        }                        
                    }
    
                    const videoUrl = await getExternalVideoUrl(article);
                    let imageUrl = null;
                    if(!videoUrl) 
                    {
                        imageUrl = await getImageUrl(article, postId);
                    }

                    const repostInfo = getRepostInfo(article);
    
                    const postData = {
                        postId,
                        postUrl,
                        postDate: getDate(postId),
                        postText,
                        postLikes,
                        postCommentsCount,
                        imageUrl,
                        videoUrl,
                        isRepost: repostInfo !== null,
                        repostInfo
                    }
                    
                    return postData;
                }
                
                await waitFor(100);
                let articles = getArticles(mainContent);

                if(articles.length === 0) return null;

                let retries = 0;
                while(articles.length <= articleIndex && retries < 5) 
                {
                    retries++;

                    $("html, body").animate({ scrollTop: 0 }, 1000);
                    await waitFor(1000);
                    $("html, body").animate({ scrollTop: document.body.scrollHeight }, 1000);
                    await waitFor(3000);

                    articles = getArticles(mainContent);
                }
        
                const article = articles[articleIndex];
        
                if(!article) return null; // End of posts
                    
                article.scrollIntoView();

                let postScrappingRetries = 0;
                let postScrapped = false;

                while(!postScrapped && postScrappingRetries < 3) 
                {
                    try 
                    {
                        const postData = await getPostData(article);
                        return postData;    
                    }
                    catch(e) 
                    {
                        await retryScrollIntoArticle(article);               
                        postScrappingRetries++;
                    }  
                }
            
                //#endregion Main function
            
                return null;
            }, index);
    
            return article;
    }

}