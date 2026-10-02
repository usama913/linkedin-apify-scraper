# Changelog

## 1.1.0

- Set PPE price to $0.0054 per successfully scraped profile (`profile-scraped` event).
- Post items now include `imageUrl`, `videoUrl`, `postId`, `isRepost` and `repostInfo` in the default dataset view.
- Added native LinkedIn video URL extraction.
- Empty fields are returned as `null` instead of being omitted.
- Updated README with pricing, input reference and output example.

## 1.0.0

- Added multi-profile input handling.
- Added profile-only mode as the default.
- Added optional public post scraping.
- Added per-successful-profile PPE billing hook.
- Added output and dataset schemas.
- Added Apify Store documentation.
- Added failed-profile handling without billing.
- Added configurable concurrency, retries, and proxy support.
