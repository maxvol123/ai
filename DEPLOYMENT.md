# Daily #DONTSKIP digest

## One-time server test

Run from the repository directory after copying/pulling the updated code:

```sh
npm run digest:test
```

This loads `.env`, renders once, saves `exports/dontskip-test-<UTC-date>-<timestamp>.png`, sends a TEST photo to the owner's `CHAT_ID`, and exits. It uses the day's saved candidates, selections and valid display copy even if the scheduled issue is already PUBLISHED or CANCELLED. If no candidate snapshot exists, it selects two highest-scored published articles from that UTC day and generates display copy via OpenAI. It requires two eligible stories rather than the scheduler's minimum of four. It never writes to the database, changes the daily issue, or sends to `TELEGRAM_CHANNEL_ID`.

```sh
# Reproduce the screenshot text with the server's configured background and logo;
# no database queries or OpenAI requests, sends the result to CHAT_ID:
npm run digest:test -- --sample

# Test a specific day's saved stories:
npm run digest:test -- --date 2026-10-27

# Save a PNG only, without sending to Telegram:
npm run digest:test -- --sample --local-only --output exports/dontskip-test.png
```

Sending requires `HTTPAPI_TG` and `CHAT_ID`; real articles also require database access and `OPENAI_API` when saved display copy is unavailable. Run with the same environment variables and working directory as the polling service to reproduce its image configuration. The command logs the configured background path, chosen stories and generated copy. It does not retry Telegram sends automatically; the PNG remains on disk if sending fails. No polling process restart or wait for 19:00 UTC is needed for this command.

## Scheduled digest

Editorial background compatibility: a legacy `DONTSKIP_TEMPLATE_PATH=assets/dontskip-template.png`, a renamed copy, or a resized/re-encoded copy with matching wordmark pixels is automatically replaced with `assets/dontskip-background.png` and logged. Bundled assets resolve relative to the application, independently of the polling process working directory; custom environment paths remain relative to that working directory. Keep the clean background in the deployed assets. Headlines are limited to x=110–900 (790px); the right number column is reserved. Saved display copy is revalidated against these bounds and regenerated when it no longer fits. Deploy the updated renderer and restart the polling process for this fix to take effect; already sent Telegram posts are not edited automatically.

The digest requires at least **four channel publications** in the current UTC day's 00:00–18:50 window. With zero to three publications, it is automatically marked `SKIPPED`, the owner is notified, and no selection pages, display-copy generation or channel upload are performed. Exactly four publications allow the usual selection of two stories. This minimum also applies to previously saved OPEN issues after a restart, even when two stories were already selected manually.

The final selection page includes a “Cancel today's digest” button. All digest instructions, buttons, callback responses and owner notifications are in English. The owner can cancel the current UTC day's issue before 19:00 UTC. Cancellation persists as `CANCELLED`, removes selection keyboards where possible, and blocks both manual and automatic publication for that date, including after a restart. The next day's issue is unaffected. This uses the existing string status field; no new database migration is needed.

Custom image base: use `assets/dontskip-background.png` or set `DONTSKIP_TEMPLATE_PATH` to a square PNG without baked-in text or logos. The renderer scales it to 1200x1200, then adds the editorial grid, branding, separate logo and UTC date. The bundled background reuses the original planet with a lower horizon. `assets/dontskip-template.png` is the legacy source artwork; using it directly would duplicate the old branding. Non-square custom backgrounds fail validation. See `assets/README.md` for coordinates. A generated planet is used if the bundled background is missing.

The existing `npm run telegram:poll` process also runs the daily scheduler. Keep one polling process running continuously. At 18:50 UTC it sends `CHAT_ID` all channel articles published between 00:00 and 18:50 UTC, in pages of five with links and selection buttons. Select exactly two; clicking a selected item removes it. Selection closes at 19:00 UTC, when the bot sends a 1200×1200 PNG and a `#DONTSKIP` caption with the two linked titles to `TELEGRAM_CHANNEL_ID`. The timer checks every second; actual delivery depends on image rendering and Telegram latency. If fewer than two stories are selected, the bot fills remaining slots with the highest overall Article.score from the original candidate list, preserving manual selections. Scores are snapshotted at 18:50; equal scores keep candidate order (publication time, then ID). Missing scores are excluded from automatic selection. Fewer than two candidates or too few scored stories to complete the selection skips the issue and sends an owner notification.

Run `npm ci`, `npx prisma generate`, `npx prisma migrate deploy`, `npm run build`, `npm test`, then restart `ai-news-telegram-poll` and the collector. Migration `20261015000000_add_daily_digest` adds `DailyDigest` and `Article.channelPublishedAt`. No production migrations are applied by the tests. Previously published articles have no reliable channel publication timestamp and are excluded; the first complete digest day is the first UTC day after deployment. Source publication timestamps remain unchanged.

Set `TELEGRAM_CHANNEL_ID` to a channel username (`@name`) or its `-100…` chat ID to link to channel posts. Otherwise source links are used. The transparent logo is bundled at `assets/tikrd-logo.png`; override it with `DONTSKIP_LOGO_PATH`. Without a logo the image uses the TIKRD wordmark. Sharp needs its platform binaries. Digest text uses `DejaVu Sans, Arial, sans-serif`; install DejaVu Sans in the environment running the bot so Cyrillic text does not render as missing-glyph squares. Sharp resolves SVG fonts through fontconfig; declaring `font-family` does not install or embed the font.

New candidate snapshots include the approved Telegram headline as editorial context, falling back to the article title. At publication, one structured OpenAI request using `SCREENING_MODEL` writes separate `kicker` and `displayHeadline` fields for the selected pair; `OPENAI_API` is required. Invalid output gets one regeneration attempt. The prompt preserves uncertainty and quantities, and validation rejects removal of may/might/could. Display copy is saved in `DailyDigest.candidates` before rendering; rendering retries reuse it. Failed generation leaves the issue OPEN without sending. Link captions retain the original titles. No database migration is needed.

The grid is left aligned at x=110 with right boundary x=1090. Kickers use 24px at y=125/575; primary headlines use 62px at y=190/255 and secondary headlines use 54px at y=640/705. Explicit baseline coordinates take precedence over the nominal type line-height values. Measured wrapping permits at most two lines and only 6px of size reduction; copy is never truncated. The 88px #DONTSKIP baseline is y=430. Logo center is (600,960), date baseline is y=1095. `npm run digest:preview` renders the supplied display-copy examples to `exports/dontskip-editorial-preview.png`; pass two quoted display headlines and optionally two kickers for custom content. This preview uses a fixed example date, makes no model calls and never sends to Telegram.

On Ubuntu/Debian, install the fonts and restart the renderer process:

```sh
sudo apt-get update
sudo apt-get install -y fontconfig fonts-dejavu-core
sudo fc-cache -f
fc-match 'DejaVu Sans'
sudo systemctl restart ai-news-telegram-poll
```

`fc-match` should report `DejaVuSans.ttf`. If the bot runs in a container, install the font packages inside its image and rebuild/restart the container.

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
