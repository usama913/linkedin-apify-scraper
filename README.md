# Linkedin Profile Scraper

Extract structured information from publicly accessible LinkedIn profile, company, school, and showcase pages.

## Pricing

This Actor is intended to use **Pay Per Event (PPE)** monetization.

- **$0.005 per successfully scraped profile**
- **1,000 profiles = $5.00**
- **100 profiles = $0.50**
- Failed profiles are not charged.
- Post scraping, when enabled, is included in the profile event and does not create one charge per post.
- Post scraping, when enabled, is included in the profile event and does not create one charge per post.

The final price and any Apify platform usage settings are configured in the Apify Console.

## Actor Name

**Linkedin Profile Scraper**

## What it extracts

### Profile information

In profile-only mode:

- Profile URL
- Name
- Headline
- About/description
- Company website
- Company size
- Followers count
- Profile type (`person`, `company`, `school`, `showcase`, or `unknown`)
- Proxy usage status

### Post information

Optional post mode can also extract:

- Post URL and ID
- Post date
- Post text
- Likes
- Comments
- Image/video URL
- Repost information

## Supported LinkedIn URLs

```text
https://www.linkedin.com/in/example/
https://www.linkedin.com/company/example/
https://www.linkedin.com/school/example/
https://www.linkedin.com/showcase/example/
```

## Input

Provide one or more publicly accessible LinkedIn profile URLs.

Example:

```json
{
  "startUrls": [
    { "url": "https://www.linkedin.com/in/example/" }
  ],
  "maxProfiles": 10,
  "onlyProfileInfo": true,
  "maxItems": 20,
  "includeProfileInfo": true,
  "useProxyOnlyAfterFail": true,
  "maxProxiedRetries": 2,
  "maxConcurrency": 2,
  "maxRequestRetries": 1,
  "requestHandlerTimeoutSecs": 180,
  "disableImagesStylesFonts": true
}
```

## Billing

The custom PPE event is `profile-scraped` at **$0.005 per successful profile**. Billing occurs only after the profile data has been successfully written to the Dataset. A profile with multiple posts still creates only one charge.

```text
1 profile       = $0.005
100 profiles    = $0.50
1,000 profiles  = $5.00
```

The rate can be changed later in the Apify Console without changing the scraping/billing logic.

## Output

Results are written to the default Apify Dataset and can be exported as JSON, CSV, XLSX, XML, or retrieved through the Apify API.

Failed URLs are returned with `status: "failed"` and are not billed.

## Proxy

The normal flow is direct scraping first, followed by proxy fallback when direct scraping fails. Successful proxy scrapes are billed once, while failed attempts are not billed.

The Actor supports Apify Proxy through the standard proxy input. For reliability, start with low concurrency and use a proxy configuration appropriate for your account and use case.

## Important

This Actor is intended for publicly accessible information. Users are responsible for complying with LinkedIn's terms, applicable laws, and privacy/data-protection requirements.

The Actor is not affiliated with, endorsed by, or sponsored by LinkedIn.
