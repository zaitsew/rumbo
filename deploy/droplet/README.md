# Droplet deploy files

- `Dockerfile` builds the web image from the standalone Next output (see `scripts/deploy.sh`).
- `docker-compose.fragment.yml` holds two services:
  - `rumbo`, the web container on port 3110 of the `apps` network.
  - `rumbo-scheduler`, a tiny `curlimages/curl` (Alpine) container. Once an hour it sends
    `POST http://rumbo:3110/api/v1/collect` with `Authorization: Bearer $RUMBO_OWNER_KEY`.
- `Caddyfile.fragment` routes `rumbo.fabriquefutur.com` to the web container.

## The hourly collector

`POST /api/v1/collect` runs every active watch whose `last_run_at` is older than its `every_hours`
and stores what the sources return. The scheduler reads `RUMBO_OWNER_KEY` from `/srv/rumbo/.env`,
the same file the web container uses, so the key is never in the repo or in the compose file.

- First deploy: `add-product.sh` renders the fragment and `scripts/deploy.sh` starts both services.
- A product that is already deployed keeps its old rendered `/srv/rumbo/docker-compose.yml`. Add the
  `rumbo-scheduler` block to it by hand (copy it from the fragment, replacing `{{name}}` with `rumbo` and
  `{{port}}` with `3110`), then run `scripts/deploy.sh`.
- Check it: `ssh deploy@159.89.99.84 "cd /srv && docker compose logs --tail 5 rumbo-scheduler"` shows one JSON line per hour, for example
  `{"watches_run":2,"observations":14,"calls":3}`.
- Spend is bounded by the sources' daily call caps (`docs/SOURCES.md`), not by this schedule.
- Run it by hand: `curl -X POST -H "Authorization: Bearer $RUMBO_OWNER_KEY" https://rumbo.fabriquefutur.com/api/v1/collect`.
