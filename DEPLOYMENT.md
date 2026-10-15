# Daily #DONTSKIP digest

Custom image base: upload a 1200x1200 PNG to `assets/dontskip-template.png` (or set `DONTSKIP_TEMPLATE_PATH`). The renderer composites only the two headlines and UTC date over the template; its background, branding and logo are preserved. See `assets/README.md` for text coordinates. Without a template the original generated design remains available.

The existing `npm run telegram:poll` process also runs the daily scheduler. Keep one polling process running continuously. At 18:50 UTC it sends `CHAT_ID` all channel articles published between 00:00 and 18:50 UTC, in pages of five with links and selection buttons. Select exactly two; clicking a selected item removes it. Selection closes at 19:00 UTC, when the bot sends a 1200×1200 PNG and a `#DONTSKIP` caption with the two linked titles to `TELEGRAM_CHANNEL_ID`. The timer checks every second; actual delivery depends on image rendering and Telegram latency. If fewer than two stories are selected, the bot fills remaining slots with the highest overall Article.score from the original candidate list, preserving manual selections. Scores are snapshotted at 18:50; equal scores keep candidate order (publication time, then ID). Missing scores are excluded from automatic selection. Fewer than two candidates or too few scored stories to complete the selection skips the issue and sends an owner notification.

Run `npm ci`, `npx prisma generate`, `npx prisma migrate deploy`, `npm run build`, `npm test`, then restart `ai-news-telegram-poll` and the collector. Migration `20261015000000_add_daily_digest` adds `DailyDigest` and `Article.channelPublishedAt`. No production migrations are applied by the tests. Previously published articles have no reliable channel publication timestamp and are excluded; the first complete digest day is the first UTC day after deployment. Source publication timestamps remain unchanged.

Set `TELEGRAM_CHANNEL_ID` to a channel username (`@name`) or its `-100…` chat ID to link to channel posts. Otherwise source links are used. Put the logo at `assets/tikrd-logo.png` or set `DONTSKIP_LOGO_PATH`; without a logo the image uses the TIKRD wordmark. Sharp needs its platform binaries, and the host should have Arial or a compatible sans-serif font installed. No OpenAI calls are used for digests.

Candidates and selections are persisted. Restarting between 18:50 and 19:00 resumes unsent selection pages; restarting later the same UTC day completes any missing selections by score and publishes the issue when two eligible stories are available. Older candidate snapshots without scores are enriched from Article by their original IDs only. Old dates are not published automatically. `PUBLISHING` is deliberately never retried automatically after a Telegram timeout or a failed database write: check the channel first and reconcile the record manually to prevent duplicate posts. Image rendering failures are safe to retry automatically. A crash between sending a selection page and saving its message ID may leave an extra selection page; only persisted message IDs accept selections.

# Telegram image captions

Event similarity is now stored as `Article.eventSimilarity` in the range 0–1 and displayed in review evaluations. After screening and event lookup, similarity strictly above 0.9 rejects the article before event updates, ranking or Telegram review. Exactly 0.9 continues through event comparison. No matching events means similarity 0. Rejected articles retain their embedding, matching event ID and rejection reason.

Apply `20261012010000_add_article_event_similarity` and regenerate the Prisma client before running the updated app. Existing articles keep a null similarity until processed again.

## Changed files

- `prisma/schema.prisma`, `src/types/article.ts`: nullable article image URL.
- `prisma/migrations/20261004000000_add_article_image_url/migration.sql`: additive `imageUrl TEXT` column.
- `src/services/article-content.service.ts`: metadata extraction during the existing page fetch; reuse fetched pages during review enrichment.
- `src/services/article-image.ts`, `src/collectors/rss.collector.ts`, `src/collectors/html.collector.ts`, `src/types/rss-parser.d.ts`: source/RSS/Atom images and shared HTTP(S) image validation.
- `src/services/article.service.ts`: preserve existing images, save immutable drafts, and record the successful channel message ID with publication status.
- `src/services/telegram-caption.ts`: JavaScript character limits, escaping, safe source links and saved HTML validation.
- `src/services/telegram-writer.service.ts`: caption generation and at most one shortening pass.
- `src/services/telegram.service.ts`: save and show the final draft before approval; photo publication with identical text fallback.
- `src/jobs/telegram-approval.job.ts`: publish the saved draft without generation; record success afterward.
- `package.json`, `tests/editorial-models.test.cjs`, `tests/telegram-publishing.test.cjs`: test command and coverage.
- `tests/article-images.test.cjs`: real RSS/Atom parsing fixtures and source-card image coverage.

## Behavior

Image priority is the existing valid stored image, then RSS/Atom media:content, media:thumbnail, image enclosures, content:encoded images, description images, and summary images. Explicit item imagery remains a final feed fallback. Article HTML then uses og:image, og:image:secure_url, Twitter image metadata and image_src links, followed by article JSON-LD (including arrays and @graph) and meaningful images inside article/main. Lazy attributes and srcset are supported; larger reasonable candidates are preferred within each source. URLs are entity-decoded and resolved against the article URL. Data URLs, SVG, obvious logos/icons/avatars and tiny images are excluded. Valid stored images are never replaced by lower-priority feed or page images. Browser-like headers, redirect following and a 15-second timeout are used for article fetches. Failed fetches, including HTTP 403, are logged and cached for the current article object without retries; available feed images survive, otherwise review uses normal text with the same controls. These diagnostics appear only in server logs. Publication never fetches article pages.

Review sends a photo when an image exists, with the exact saved HTML caption and Approve/Reject inline keyboard attached directly to sendPhoto. Failed photos fall back to sendMessage with the identical draft and keyboard; missing images use this same text review. Approve publishes the saved string without generation, while Reject prevents publication. Successful channel message IDs are recorded atomically with PUBLISHED status. The existing conditional approval update guards duplicate callbacks. Database unavailability does not select a reduced production review mode.

The writer targets 650-850 characters and enforces a 900-character maximum on the entire final HTML string, including markup, escaped entities, source URL, spaces and line breaks. This is stricter than counting only visible Telegram text. One shortening pass is allowed; invalid output fails before saving or sending. Source HTML is built by code and all model text is escaped.

No new dependencies or environment variables. Generation and shortening reuse the existing `SCREENING_MODEL` configuration and `OPENAI_API` credential. This adds one model request per new review draft, plus one request only if shortening is necessary.

Old review messages without a saved draft cannot publish; send them through a fresh review first. Invalid legacy drafts also require a fresh reviewed replacement, never an approval-time rewrite. Failed or ambiguous publication remains APPROVED under the existing error handling; inspect the channel before manually retrying. Telegram delivery and database writes cannot be one transaction.

## VPS deployment

After these changes are committed and pushed, run from the repository directory:

```sh
git pull
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm test
sudo systemctl restart ai-news-collector
sudo systemctl restart ai-news-telegram-poll
```

The migration only adds a nullable column. No database reset or data deletion is required. Local tests mock Telegram, OpenAI and database calls; they do not publish messages or apply production migrations.
