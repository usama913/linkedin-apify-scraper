export default class ArticleProvider {
    constructor({
        page,
        log,
    }) {
        this.page = page;
        this.log = log;
    }


    async getArticle(index) {
        return await this.page.evaluate(
            (index) => {
                // ------------------------------------------------
                // Find LinkedIn post elements
                // ------------------------------------------------

                const selectors = [
                    '[data-urn*="activity"]',
                    '[data-id*="activity"]',
                    'div.feed-shared-update-v2',
                    'article',
                ];

                let posts = [];

                for (const selector of selectors) {
                    posts =
                        Array.from(
                            document.querySelectorAll(
                                selector
                            )
                        );

                    if (posts.length > 0) {
                        break;
                    }
                }

                const post =
                    posts[index];

                if (!post) {
                    return null;
                }


                // ------------------------------------------------
                // Helpers
                // ------------------------------------------------

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
                            post.querySelector(selector);

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
                            post.querySelector(selector);

                        if (element) {
                            const value =
                                element.getAttribute(
                                    attribute
                                );

                            if (value) {
                                return value.trim();
                            }
                        }
                    }

                    return undefined;
                };


                // ------------------------------------------------
                // Post ID
                // ------------------------------------------------

                let postId =
                    getAttribute(
                        [
                            '[data-urn]',
                            '[data-id]',
                        ],
                        'data-urn'
                    );


                if (!postId) {
                    postId =
                        getAttribute(
                            [
                                '[data-id]',
                            ],
                            'data-id'
                        );
                }


                if (postId) {
                    const activityMatch =
                        postId.match(
                            /activity[:\-](\d+)/i
                        );

                    if (activityMatch) {
                        postId =
                            activityMatch[1];
                    } else {
                        const numericMatch =
                            postId.match(
                                /(\d{8,})/
                            );

                        if (numericMatch) {
                            postId =
                                numericMatch[1];
                        }
                    }
                }


                // ------------------------------------------------
                // Post URL
                // ------------------------------------------------

                let postUrl =
                    getAttribute(
                        [
                            'a[href*="/posts/"]',
                            'a[href*="activity-"]',
                        ],
                        'href'
                    );


                if (postUrl) {
                    try {
                        postUrl =
                            new URL(
                                postUrl,
                                window.location.origin
                            ).href;
                    } catch {
                        // Keep original.
                    }
                }


                // ------------------------------------------------
                // Post date
                // ------------------------------------------------

                const timeElement =
                    post.querySelector('time');

                let postDate;

                if (timeElement) {
                    postDate =
                        timeElement.getAttribute(
                            'datetime'
                        ) ||
                        cleanText(
                            timeElement.innerText
                        );
                }


                // ------------------------------------------------
                // Post text
                // ------------------------------------------------

                const postText =
                    getText([
                        '.feed-shared-update-v2__description',
                        '.feed-shared-text',
                        '.update-components-text',
                        '.feed-shared-inline-show-more-text',
                        '.break-words',
                    ]);


                // ------------------------------------------------
                // Likes
                // ------------------------------------------------

                let postLikes;

                const likesText =
                    getText([
                        '.social-details-social-counts__reactions-count',
                        '[aria-label*="reaction"]',
                        '[aria-label*="like"]',
                    ]);

                if (likesText) {
                    const match =
                        likesText.match(
                            /([\d,.]+)/ 
                        );

                    if (match) {
                        const number =
                            Number(
                                match[1]
                                    .replace(/,/g, '')
                                    .replace(/\./g, '')
                            );

                        if (
                            Number.isFinite(number)
                        ) {
                            postLikes = number;
                        }
                    }
                }


                // ------------------------------------------------
                // Comments
                // ------------------------------------------------

                let postCommentsCount;

                const commentsText =
                    getText([
                        '.social-details-social-counts__comments',
                        '[aria-label*="comment"]',
                    ]);

                if (commentsText) {
                    const match =
                        commentsText.match(
                            /([\d,.]+)/
                        );

                    if (match) {
                        const number =
                            Number(
                                match[1]
                                    .replace(/,/g, '')
                                    .replace(/\./g, '')
                            );

                        if (
                            Number.isFinite(number)
                        ) {
                            postCommentsCount =
                                number;
                        }
                    }
                }


                // ------------------------------------------------
                // Image
                // ------------------------------------------------

                const imageElement =
                    post.querySelector(
                        'img'
                    );

                let imageUrl;

                if (imageElement) {
                    imageUrl =
                        imageElement.getAttribute(
                            'src'
                        ) ||
                        imageElement.getAttribute(
                            'data-src'
                        );
                }


                // ------------------------------------------------
                // Video
                // ------------------------------------------------

                const videoElement =
                    post.querySelector(
                        'video'
                    );

                let videoUrl;

                if (videoElement) {
                    videoUrl =
                        videoElement.getAttribute(
                            'src'
                        );

                    if (!videoUrl) {
                        const source =
                            videoElement.querySelector(
                                'source'
                            );

                        if (source) {
                            videoUrl =
                                source.getAttribute(
                                    'src'
                                );
                        }
                    }
                }


                // ------------------------------------------------
                // Repost detection
                // ------------------------------------------------

                const repostText =
                    cleanText(
                        post.querySelector(
                            '.feed-shared-header'
                        )?.innerText
                    );

                const isRepost =
                    !!(
                        repostText &&
                        /repost|reposted/i.test(
                            repostText
                        )
                    );


                // ------------------------------------------------
                // Repost information
                // ------------------------------------------------

                let repostInfo;

                if (isRepost) {
                    repostInfo =
                        repostText;
                }


                // ------------------------------------------------
                // Return article
                // ------------------------------------------------

                return {
                    postId,
                    postUrl,
                    postDate,
                    postText,

                    postLikes,
                    postCommentsCount,

                    imageUrl,
                    videoUrl,

                    isRepost,
                    repostInfo,
                };
            },

            index
        );
    }
}