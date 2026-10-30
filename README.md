# photo-blog

A small self-hosted photo site with albums. Upload from a private admin page and the site does the rest.

- **Automatic optimizing:** WebP and JPEG at up to five sizes within seconds, then AVIF in the background, so every screen gets only what it needs
- **EXIF on every photo:** camera, lens, settings, editor and crop percentage, read with exiftool
- **Private by default:** GPS and all other metadata are removed from public images, and originals are never served
- **Likes and comments without accounts:** comments stay hidden until you approve them
- **Bot protection:** Cloudflare Turnstile, a honeypot, a no-links rule and rate limits
- **Stats without tracking:** views per photo, countries, referrers and a 30-day failure log, with no IP addresses or analytics cookies
- **AI drafts, optional:** any OpenAI-compatible vision model suggests a title, description, tags and moods, and nothing goes public until you approve it
- **Privacy review:** an optional AI scan proposes face and license plate blurs, you adjust them, and new photos stay offline until approved
- **Your signature, optional:** a transparent SVG becomes a watermark, placed in the calmer bottom corner in light or dark ink, with camera settings under it if you want them
- **Works on phones:** swipe between photos, and the admin works there too

Built with Node 22, Hono, SQLite, sharp and exiftool. No build step and no frontend framework.

## Run it

You need Docker and a Cloudflare Turnstile widget for your domain.

```sh
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data
```

Fill in `.env` as its comments describe, then:

```sh
docker compose up -d --build
```

The site listens on `127.0.0.1:3000`. Put a reverse proxy with HTTPS in front of it. The admin is at `/admin`. Publishing a photo also publishes its album.

## AI drafts and privacy review

Both are optional and off until you set `CAPTION_API_URL`, `CAPTION_API_KEY` and `CAPTION_MODEL`. Each has its own switch on the admin Settings page. When they are on, your photos are sent to that API, so choose one you trust.

**Captions.** The model looks at each uncaptioned photo and drafts a title, description, tags and moods. Drafts wait on the Captions page, and you approve, edit or dismiss them. Nothing shows on the site until you approve it.

**Blur.** The model marks faces and readable license plates, and each box is enlarged by 30% because models tend to draw them tight. On the Privacy page you click a box to turn its blur off or on, and drag on the photo to add one. New photos stay offline until you approve them.

A blurred area is shrunk to a few pixels before it is smoothed, so it can't be sharpened back into a face. The blur is baked into every public image and your original stays untouched, so you can change your mind later. The AI can miss things, which is why you approve each photo yourself.

## Watermark

Put a transparent SVG at `data/watermark.svg`. Its shape is used and its colors are ignored. The worker then rebuilds every photo one at a time, and it does so again if you change or remove the file. Originals stay clean. Without the file, photos have no watermark. The admin Settings page turns it off and on and can add the camera settings under it.

## Before you go live

- Use a random `ADMIN_USERNAME` and a long password. Putting an access gate such as Cloudflare Access in front of `/admin` is a good second lock.
- `TRUST_CF=1` makes rate limits use the `CF-Connecting-IP` header, so only set it when your server accepts traffic from Cloudflare alone.
- Without `TRUST_CF=1`, a reverse proxy makes all visitors look like one address, which makes rate limits shared. Behind Cloudflare, use `TRUST_CF=1`.
- Back up `data/`. It holds your originals and the database.
- Rebuild regularly. sharp bundles the image decoders, and they get security fixes.

## Develop

```sh
npm install
npm test
npm start
```

Tests need `exiftool`. On macOS with Homebrew's vips installed, set `SHARP_IGNORE_GLOBAL_LIBVIPS=1` for `npm install`.

To show approximate crop percentages for your own camera, add its native resolution to `SENSOR_SIZES` in `lib/images.js`.

## License

MIT
