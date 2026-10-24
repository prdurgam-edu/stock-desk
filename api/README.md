# Stock Desk cloud service

The part of the dashboard that runs in Google Cloud. It does two things:

1. **Reads tag photographs.** PaddleOCR's PP-OCRv4 models — the same files the
   page uses in `ocr/models` — on ONNX Runtime's native engine. It returns the
   lines of text; the page decides which design code they name, because the
   page has the workbook. About a second a photograph, against three or more
   in a browser, and nothing for the shop computer to download.
2. **Keeps the files and the history** in a private Cloud Storage bucket: each
   photograph, each workbook exactly as uploaded, and the computed history.
   Any computer that opens the page sees the same dashboard.

There is no sign-in. The service holds the permission to the bucket and the
page talks only to the service. Anyone who learns the service's address can
read and change what it keeps; `ALLOWED_ORIGINS` stops other websites from
using it in a browser, not a determined person. Fine for a demo — add sign-in
before real use.

## Deploy

In [Google Cloud Shell](https://shell.cloud.google.com), signed in to the
project:

```bash
git clone https://github.com/prdurgam-edu/stock-desk.git && cd stock-desk && bash api/deploy.sh
```

It enables the APIs it needs, creates the bucket
`project-2091804d-e7bc-4992-b42-stock-desk` in Mumbai if it isn't there,
lets the service use it, builds the `Dockerfile` at the repository root, deploys
**stock-desk-api** to Cloud Run beside tag-matcher, runs the self-test and
prints the service's address. Then set that address in `index.html`:

```js
api: "https://stock-desk-api-….a.run.app",
```

Running it again updates the service in place; the bucket and everything in it
stay.

## Settings

| Variable | Default | |
|---|---|---|
| `BUCKET` | set by `deploy.sh` | Unset, files go to `./data` — for testing on a laptop |
| `PREFIX` | `stock/` | Folder inside the bucket |
| `ALLOWED_ORIGINS` | the GitHub Pages site | Comma-separated sites allowed to call the service |
| `TASKS_QUEUE` | set by `deploy.sh` | The Cloud Tasks queue reads go through. Unset, photographs are read one by one inside the process — for a laptop |

`deploy.sh` caps the service at six instances and lets it sleep when unused,
so it costs nothing while idle. The first request after a sleep takes a few
seconds longer while it wakes; the page says so.

### Background reading

The page stores the photographs and posts their ids to `/api/process`. The
service creates one Cloud Tasks task per photograph (queue `stock-desk-reads`,
six at a time, up to eight attempts with backoff); each task calls
`/api/task/read?id=`, which reads the tag and writes `reads/<id>.json`, with
the lines also in the object's metadata so `/api/reads` gets every reading
from one listing. No browser needs to be open. The history (`state.json`) is
written only by the page, which applies the readings when it next opens, so
the two never overwrite each other.

## Endpoints

| | |
|---|---|
| `GET /api/ping` | What is running and where files are kept |
| `POST /api/read` | Body: an image. Returns `{ lines, ms }` |
| `POST /api/read?id=` | Reads a photograph already stored here |
| `GET`, `PUT /api/state` | The computed history (gzip accepted both ways) |
| `GET`, `PUT /api/blob/:id` | Tag photographs |
| `GET`, `PUT /api/raw/:id` | Workbooks as uploaded |
| `POST /api/wipe` | Deletes everything |
| `GET /api/selftest` | Reads a made-up tag (`selftest.jpg`) and checks the result |
| `POST /api/process` | Body `{ ids }`: queue these photographs for reading |
| `POST /api/task/read?id=` | One background read; Cloud Tasks calls this |
| `GET /api/reads?since=` | Every reading so far (or newer than `since`) |

## Run it on a laptop

```bash
cd api && npm ci --ignore-scripts
mkdir -p models && cp ../ocr/models/ch_PP-OCRv4_det_infer.onnx ../ocr/models/ppocr_keys_v1.txt models/
cat ../ocr/models/ch_PP-OCRv4_rec_infer.onnx.part1 ../ocr/models/ch_PP-OCRv4_rec_infer.onnx.part2 > models/ch_PP-OCRv4_rec_infer.onnx
node server.js        # http://localhost:8080, files in ./data
```
