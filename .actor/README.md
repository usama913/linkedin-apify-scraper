# LinkedIn Public Profile Scraper

Extract structured information from publicly accessible LinkedIn profile pages.

## Pricing

This Actor is intended to use **Pay Per Event (PPE)** monetization.

- **$0.10 per successfully scraped profile**
- **10 profiles = $1.00**
- Failed profiles are not charged.
- Post scraping, when enabled, is included in the profile event and does not create one charge per post.

The final price and any Apify platform usage settings are configured in the Apify Console.

## What it extracts

In profile-only mode:

- Profile URL
- Name
- Headline
- About/description
- Company website
- Company size
- Followers count

Optional post mode can also extract:

- Post URL and ID
- Post date
- Post text
- Likes
- Comments
- Image/video URL
- Repost information

## Input

Provide one or more publicly accessible LinkedIn profile URLs.

Example:

```json
{
  "startUrls": [
    { "url": "https://www.linkedin.com/in/example/" }
  ],
  "maxProfiles": 10,
  "onlyProfileInfo": true
}
```

## Output

Results are written to the default Apify Dataset and can be exported as JSON, CSV, XLSX, XML, or retrieved through the Apify API.

Failed URLs are returned with `status: "failed"` and are not billed.

## Proxy

The Actor supports Apify Proxy through the standard proxy input. For reliability, start with low concurrency and use a proxy configuration appropriate for your account and use case.

## Important

This Actor is intended for publicly accessible information. Users are responsible for complying with LinkedIn's terms, applicable laws, and privacy/data-protection requirements.

The Actor is not affiliated with, endorsed by, or sponsored by LinkedIn.
