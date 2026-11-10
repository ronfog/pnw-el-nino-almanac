# PNW El Niño Almanac

What this winter's strong El Niño means where you live in the Pacific Northwest (Washington, Oregon, southwest BC), and what to plant or protect because of it.

- **Outlook:** month-by-month temperature, rain and snow leans for 24 PNW towns, from NOAA Climate Prediction Center outlooks, with a check of how the forecast has held up at local weather stations.
- **Garden:** what to start indoors, set out or sow each month for 205 plants, adjusted for garden zone and El Niño, plus traditional herbs, essential-oil plants and an overwintering guide.
- **Ask the Almanac:** an AI assistant (Claude, by Anthropic) that answers questions using only the app's own data, through eight lookup tools. It declines to invent dates, forecast single days, or give medical, legal or financial advice.

## How it's built

| Part | File | Notes |
|---|---|---|
| Page | `public/index.html` | Static HTML, CSS and JavaScript. No framework. |
| Data and logic | `public/engine.js` | Single source for the outlook, plant data, planting math and the Ask tools. |
| Ask endpoint | `netlify/functions/ask.mjs` | Netlify Function at `/api/ask`. Keeps the API key on the server, runs the tool loop, enforces daily limits. |
| Engine copy | `netlify/functions/_engine.cjs` | Generated from `engine.js` on every build by `scripts/sync-engine.mjs`. Don't edit it. |
| Tests | `scripts/test-ask.mjs` | `npm test`. Offline: fakes the AI service and storage. |

### Cost and abuse controls

- Daily question limits per visitor (default 15) and for the whole site (default 300), counted with Netlify Blobs. Visitors are stored as a one-way hash, never a raw IP address.
- The AI account runs on prepaid credits with auto-reload off, so spending can't exceed what's been bought.

## Settings (Netlify > Site configuration > Environment variables)

| Variable | Required | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (mark as secret) | none |
| `MODEL` | No | `claude-haiku-5-5` |
| `DAILY_LIMIT_PER_VISITOR` | No | `15` |
| `DAILY_LIMIT_TOTAL` | No | `300` |

Never put the API key in this repository.

## Updating the data

Edit `public/engine.js` (for example after NOAA's monthly El Niño update), commit, and Netlify redeploys automatically.

## Evaluation

The Ask feature was tested against a 71-question evaluation set (El Niño facts, local outlooks, planting logic, made-up-plant and single-day-forecast traps, out-of-scope and safety questions, traditional herbs). Failures found during testing, such as a tool crash and an answer that relied on general knowledge instead of the data, were fixed and re-tested.

## Data sources

NOAA Climate Prediction Center (ENSO discussions and seasonal outlooks); NWS monthly climate reports; WSU and OSU Extension planting calendars; NIH NCCIH herb fact sheets; Poison Control; Washington State Noxious Weed Control Board. Planting windows are guidance, not guarantees: check local frost dates.
