# photo-blog

A small self-hosted photo site with albums. Upload from a private admin page and the site does the rest.

- **Automatic optimizing:** AVIF, WebP and JPEG at up to five sizes, so every screen gets only what it needs
- **EXIF on every photo:** camera, lens, settings, editor and crop percentage, read with exiftool
- **Private by default:** GPS and all other metadata are removed from public images, and originals are never served
- **Likes and comments without accounts:** comments stay hidden until you approve them
- **Bot protection:** Cloudflare Turnstile, a honeypot, a no-links rule and rate limits
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
