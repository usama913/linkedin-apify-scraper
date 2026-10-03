# LinkedIn Public Profile Scraper

Extract structured information from publicly accessible LinkedIn profile and company pages, with optional public post extraction including image and video URLs.

## Pricing

This Actor uses **Pay Per Event (PPE)** monetization. Platform usage and proxies are included.

| Event | Price |
| --- | --- |
| `profile`: one successfully scraped profile or company page | **$0.004** |
| `post`: one post saved to the dataset | **$0.002** |
| Actor start (once per run, per GB of memory) | **$0.003** |

- Example: 10 company pages with 10 posts each = 10 × $0.004 + 100 × $0.002 + $0.003 = **$0.243**.
- With **Only profile info** turned on you pay only the profile event.
- Failed profiles (page not found, login wall, unreachable) are **not charged**.
- Use **Maximum profiles** (`maxProfiles`) and **Maximum posts per profile** (`maxItems`) to cap your spend per run.

## What it extracts

### Profile information

- Profile URL
- Name
- Headline / industry
- About / description
- Company website
- Company size
- Followers count

### Posts (optional)

- Post ID and URL
- Post date (ISO 8601)
- Post text
- Likes and comments count
- Image URL (post image, document cover, or video thumbnail)
- Video URL (native LinkedIn video or external embed)
- Repost flag and reposted profile information

## Input

Provide one or more publicly accessible LinkedIn profile or company URLs.

| Field | Default | Description |
| --- | --- | --- |
| `startUrls` | | LinkedIn profile/company URLs to scrape. |
| `maxProfiles` | `10` | Maximum number of profiles to process (and charge for). |
| `onlyProfileInfo` | `true` | Return profile information only, without posts. |
| `maxItems` | `10` | Maximum posts per profile. |
| `onlyPostsNewerThan` | | Only return posts newer than this date. |
| `includeProfileInfo` | `false` | Add profile fields to every post item. |
| `proxy` | no proxy | Apify Proxy configuration. |
| `useProxyOnlyAfterFail` | `false` | Try direct first, retry through proxy on failure. |
| `maxProxiedRetries` | `5` | Retries through proxy. |
| `maxRequestRetries` | `2` | Request retries. |
| `maxConcurrency` | `1` | Pages processed in parallel. |
| `disableImagesStylesFonts` | `true` | Block heavy resources for faster scraping. |

### Profile only

```json
{
  "startUrls": [
    { "url": "https://www.linkedin.com/company/example/" }
  ],
  "maxProfiles": 10,
  "onlyProfileInfo": true
}
```

### Profile with posts

```json
{
  "startUrls": [
    { "url": "https://www.linkedin.com/company/example/" }
  ],
  "onlyProfileInfo": false,
  "includeProfileInfo": true,
  "maxItems": 10
}
```

## Output

Results are written to the default Apify Dataset and can be exported as JSON, CSV, XLSX, XML, or retrieved through the Apify API.

Example post item (with `includeProfileInfo: true`):

```json
{
  "url": "https://www.linkedin.com/company/example/",
  "profileName": "Example Ltd",
  "profileTitle": "Retail",
  "profileDescription": "About the company...",
  "companyUrl": "https://www.example.com",
  "companySize": "10,001+ employees",
  "followersCount": 421226,
  "isProxyUsed": false,
  "postId": "7511379723784962048",
  "postUrl": "https://www.linkedin.com/posts/example_activity-7511379723784962048-abcd",
  "postDate": "2026-10-01T11:01:20.837Z",
  "postText": "Post text...",
  "postLikes": 60,
  "postCommentsCount": 3,
  "imageUrl": "https://media.licdn.com/dms/image/...",
  "videoUrl": null,
  "isRepost": false,
  "repostInfo": null
}
```

Fields with no value are returned as `null`, so every item has the same shape. Media URLs are served by LinkedIn and may expire after some time.

Failed URLs are returned with `status: "failed"` and a `note` explaining why. They are not charged.

## Proxy

The Actor supports Apify Proxy through the standard proxy input. For reliability, start with low concurrency and use a proxy configuration appropriate for your account and use case.

## Important

This Actor is intended for publicly accessible information. Users are responsible for complying with LinkedIn's terms, applicable laws, and privacy/data-protection requirements.

The Actor is not affiliated with, endorsed by, or sponsored by LinkedIn.
