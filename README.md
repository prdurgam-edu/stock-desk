# Narsingh Stock Desk

A self-contained web dashboard for Shri Narsingh Fashions. Upload the daily ASR
stock report, press **Compute**, and the page rebuilds itself. Nothing in it
depends on Claude or on any service other than the one you host it on.

---

## What it does

- Reads the **daily** ASR export (`From 02-Oct-2026 To 02-Oct-2026`) and keeps each
  day's movement, building its own history as you upload one file a day.
- Reads a **full-period** export too, and takes the **design → seller map** from its
  Supplier column, which the daily export does not carry.
- Judges every line on **weeks to clear at its current pace**, not on the share of a
  lot that happens to have sold.
- Stores the WhatsApp tag photographs and **reads the design code off each tag in
  the browser itself** with PaddleOCR, so there is no OCR service to run or pay for.
- The **Uploaded files** button in the header lists every workbook ever loaded, what
  period it covered, and lets you remove one and recompute without it.

---

## Running it

Any static web host works. The whole thing is six files plus `vendor/` and `ocr/`.
No build step, no server-side code, no special headers.

**Try it on this machine first**

```bash
cd narsingh-dashboard
python3 -m http.server 8080
```

Open <http://localhost:8080>. It works immediately: history is kept in the
browser's own database, no accounts, no setup.

**Put it on the web**

Copy the folder to any host — Firebase Hosting, a Google Cloud Storage static
site, Netlify, cPanel, or a folder on your own server. There is no build step and
no server-side code.

```bash
# Example: Firebase Hosting
npm install -g firebase-tools
firebase login
firebase init hosting      # public directory: narsingh-dashboard
firebase deploy
```

---

## Keeping the history in Google Cloud

Browser storage is per-machine: the shop computer and your laptop would each have
their own history. Point the app at a Cloud Storage bucket and every machine sees
the same data.

### 1. Make a bucket

```bash
gcloud storage buckets create gs://narsingh-stock-data \
  --location=asia-south1 --uniform-bucket-level-access
```

### 2. Let the browser talk to it

Save this as `cors.json`:

```json
[{
  "origin": ["https://your-dashboard-domain"],
  "method": ["GET", "POST", "PUT", "HEAD"],
  "responseHeader": ["Content-Type", "Authorization", "x-goog-resumable"],
  "maxAgeSeconds": 3600
}]
```

```bash
gcloud storage buckets update gs://narsingh-stock-data --cors-file=cors.json
```

Without this step the browser blocks every request and the app silently falls
back to local storage. Use your real domain, not `*`.

### 3. Create an OAuth client

In Google Cloud console → **APIs & Services → Credentials → Create credentials →
OAuth client ID → Web application**. Add your dashboard's URL under *Authorised
JavaScript origins*. Copy the client ID.

### 4. Give your people access

```bash
gcloud storage buckets add-iam-policy-binding gs://narsingh-stock-data \
  --member=user:someone@yourshop.com --role=roles/storage.objectAdmin
```

Only the accounts you list here can read or write. Anyone else signing in is
refused by Google, not by this page.

### 5. Fill in the config

In `index.html`, near the top:

```js
window.NARSINGH_CONFIG = {
  gcsBucket:      "narsingh-stock-data",
  gcsPrefix:      "stock/",
  googleClientId: "1234-abcd.apps.googleusercontent.com",
  ...
};
```

Reload. The footer will say *history kept in bucket narsingh-stock-data*. The
first cloud action each day asks you to sign in with Google.

What lands in the bucket:

```
stock/state.json              the computed history
stock/uploads/<id>-<name>     every workbook exactly as uploaded
stock/photos/<id>             each tag photograph
```

---

## Automatic design-code tagging

Photographs are read **inside the browser**. PaddleOCR's PP-OCRv4 detection and
recognition models — the same two models your Cloud Run container was running —
execute on `onnxruntime-web` in WebAssembly. There is no server, no API key, no
Gemini, and no per-photograph cost. Nothing leaves the shop computer.

```js
ocr: { path: "ocr/" },           // where the reader's files live
tagMatcher: { column: "C. REF" } // the workbook column codes are matched against
```

### What ships in `ocr/`

| File | Size | Gzipped |
|---|---|---|
| `ocr.bundle.js.part1` + `.part2` | 10.3 MB | 3.4 MB |
| `ort/ort-wasm-simd-threaded.wasm.part1` + `.part2`, and `.mjs` | 13.6 MB | 3.6 MB |
| `models/ch_PP-OCRv4_det_infer.onnx` | 4.6 MB | 4.2 MB |
| `models/ch_PP-OCRv4_rec_infer.onnx.part1` + `.part2` | 10.4 MB | 9.5 MB |
| `models/ppocr_keys_v1.txt` | 26 KB | — |

The three largest files are kept in two halves so that no single file is over
8 MB — some ways of uploading a site, GitHub's web upload among them, take 10 MB
at a time. `matcher.js` fetches both halves and joins them in memory; the bytes
the reader runs are identical. Keep the halves together and don't rename them.

About **21 MB over the wire**, fetched the first time a photograph is read and
then cached by the browser. Turn gzip on at your host and it is a one-off
half-minute wait. The dashboard itself loads instantly: the reader is pulled in
only when there is a tag to read.

It runs **single-threaded on purpose**, so no `SharedArrayBuffer` and therefore
no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers are
needed. Any plain static host works. Expect roughly **3 seconds a photograph**
on a normal shop desktop, plus about five seconds to warm the models up once.

### From what the camera saw to a design code

The reader returns every line of text on the tag. The dashboard throws away the
shop name, *Dupatta*, *SINCE 1964*, the MRP, the metres, the item number and the
barcode, then tries the rest against the design codes in your own workbook, best
first:

| Test | Score | Example |
|---|---|---|
| Exact | 1.00 | `RFDC201` |
| Character confusion, and only one real code folds to it | 0.93 | `RFDAS23K0TACHE` → `RFDAS23KOTACHE` (a zero read for the letter O) |
| Completes to exactly one code | 0.86 | `5572NETD` → `5572NETDUP` |
| One code sits inside the reading | 0.80 | |
| One or two characters away from exactly one code | 0.72–0.79 | |

`O/0`, `I/1/L`, `S/5`, `B/8`, `Z/2` and `G/6` are the pairs that get folded —
the confusions a printed tag actually produces. A folded reading is only
accepted when **exactly one** real design code folds to it, so the fold can
never invent a code.

| Score | Dashboard does |
|---|---|
| 0.90 and clear of the runner-up | Tags the photo. It appears in the Saree column, leaves Tag photographs, and lands in **System labeled**. |
| 0.70 to 0.90 | Holds it in Tag photographs with the likely code as a one-click button. |
| Two codes within 0.06 of each other | Holds it, offering both as buttons. |
| Below 0.70 | Holds it for a typed code, and shows what it did read. |

**Only a 0.90 tags without a person.** On top of that, a code can only ever come
from your own workbook, so an unknown code cannot enter. That catches an
invented code — it does not catch a confident misread of one real code for
another (`40145/XL` for `40143/XL`), which is why **System labeled** exists and
why spot-checking the first few batches is still worth it.

### The barcode as a second opinion

The 11-digit number under the design code is set in a clean font at twice the
size, and it comes out right far more often than the code does. The dashboard
keeps it on every photograph it reads. It is used for one thing today: a piece
usually gets photographed twice — once showing the goods, once close up — and
**when two photographs carry the same barcode they are the same piece**, so an
unreadable one takes the code from its twin. That is an identity, not a guess.

The day your billing software can export a barcode-to-`C. REF` list, drop it in
and every photograph with a legible barcode becomes certain rather than
probable. The number is already being captured for that.

### Several photographs of one piece

The shop sends photographs the same way every time: a shot of the whole stack —
every colour of one design — then, ten to forty seconds later, a close-up of the
tag on one of them. A batch ends with the seller's name as a message, then a
full stop. The stack shot is the better picture of the goods, and it never
carries a readable code: the tag is a centimetre across in it.

So each photograph with no code is linked to the close-up sent beside it.
`pieces.js` holds the rules; it uses what the WhatsApp export already contains.

| Signal | From | Used for |
|---|---|---|
| When it was sent, to the second | `_chat.txt`, or the filename (`…-PHOTO-2026-09-11-12-33-19.jpg`) | A close-up of the same piece comes within 60 seconds |
| Who sent it | `_chat.txt` | Photographs from different phones are never paired |
| The caption closing the batch | `_chat.txt` | `"Tulsi fabrics India private limited"` must be the design's seller |

**When it links on its own.** One close-up within the minute, or one at least
twice as near as any other — and the batch caption, if it names a seller, names
this design's seller. The photograph goes to **System labeled** with a *Same
piece* badge and the close-up it was matched to shown beside it, so checking it
is a matter of looking at two pictures of cloth.

**When it asks.** Two close-ups about equally near, a caption naming a
different seller, or the reader having suggested something else. The photograph
stays in Tag photographs with the close-ups as buttons — each button carries its
close-up's picture, nearest first.

**Captions also settle close-ups.** When the reader holds a code back — `HR390`
is short, `5572NETD` only completes to one code — and the batch caption names
that design's seller, the two agree and it is tagged, badged *Read + caption*.

**It follows corrections.** Correct a close-up's code by hand and its stack shot
moves with it. Unmap a close-up and its stack shot goes back to Tag photographs
too; map the close-up back and the stack shot follows it again. A pairing anyone
rejects is never made again on its own. The photograph you unmapped waits in
**Manually unmapped** — map it back from there if that was a mistake.

**In Lines** a design shows its stack shot, with a `+1` on it when there are more
photographs. Clicking opens all of them — use the arrows or ← →.

Seller names are compared word by word, allowing one typo in a long word
(`Ambadal` is `AMBADAAL`, `Krishna creations` is `KRISHNA KREATION`), and words
half the trade shares — *fabrics*, *silk*, *creation* — do not count on their
own, so `Krishna creations` is not `Novelty creation`. A caption that names no
seller the workbook knows, such as `Reyna`, is ignored rather than trusted.

On your export: **15 of the 16 stack shots that had a close-up beside them were
linked, all correctly**; the 16th (0457, sent 21 seconds before one close-up and
31 after another) is offered with the right code first. Two held close-ups were
settled by their captions. The one left, 0682, had its close-up dropped from the
export. **43 of 45 tagged, none wrong** — against 26 from reading tags alone.

### Measured on your own tags

Eight close-up photographs, codes known in advance:

| Tag | Read | Outcome |
|---|---|---|
| `4085BEADSVIKSON` | exact | tagged |
| `1991075/DUP` | exact | tagged |
| `80262JAQPURTIS` | exact | tagged |
| `COT/COTKALAM` | exact | tagged |
| `RFDC201` | exact | tagged |
| `TISSUEDUP/550` | exact | tagged |
| `RFDAS23KOTACHE` | `RFDAS23K0TACHE` | tagged — folded, one candidate |
| `5572NETDUP` | `5572NETD` | held for review, right code offered as a button |

Seven tagged on their own, one held, **none wrong**. The barcode came out right
on all eight.

Then the whole WhatsApp export, 45 photographs, nothing hand-picked:

| | |
|---|---|
| Tagged on their own | 26 (25 read outright, 1 from its twin's barcode) |
| Held with the right code offered as a button | 2 |
| No code found | 17 |
| **Wrong** | **0** |
| Time | 3.4 seconds a photograph |

**All 17 misses are photographs of the goods, not of the tag** — the tag is a
centimetre across in the frame and the code is a few pixels high. Reading them
again at two and three times the size recovers the word *Narsingh* and nothing
more: the detail is not in the file. The one lever that would move this number
is not software. **A close-up of the tag, the way the other 28 were taken, is
read correctly almost every time.** Whoever sends the WhatsApp photographs only
has to stand a foot closer for one shot.

Those 28 close-ups are the fair measure of the reader: 26 tagged, 2 held, none
wrong.

Watch **System labeled** for the first few real batches all the same.

### The three places a photograph can be

| Where | Meaning |
|---|---|
| **Saree column** in Lines | Tagged. The photo sits next to its design's numbers. Press **With photo** above the table to see only these lines. |
| **Tag photographs** | Still undecided — `CHECK`, `AMBIGUOUS`, `NO MATCH` or an error. Type a code or click a suggested one, and it leaves this section. |
| **System labeled** | Tagged automatically with no one confirming it, each showing how: read off the tag, same barcode, read + caption, or same piece as a close-up. A confident misread hides here, so this is the section to spot-check. *Wrong — unmap it* moves it to Manually unmapped, and **Refresh** puts back everything removed from here at once. |
| **Manually mapped** | Linked by hand. *Remove this mapping* moves it to Manually unmapped. |
| **Manually unmapped** | Every label you removed, from either section, newest first, with when you removed it. **Map back to …** restores it exactly as it was and returns it to the section it came from; the code box gives it a different design instead. Nothing automatic touches these — not *Read codes again*, not barcode twins, not linking — until you decide. |

The code box validates against the workbook as you type, so a typo or an MRP
value cannot be saved as a design code.

**Refresh**, beside System labeled, undoes an accidental removal. The label the
reader gave is remembered when you send a photo back, so Refresh restores it
exactly — same code, same confidence, without reading the tag a second time. The
number on the button is how many removed labels are waiting to be restored.
Photographs with nothing remembered are read again in the same pass, so one press
covers both. A label you rejected on purpose comes back too; reject it again.

---

## Settings you may want to change

In the `NARSINGH_CONFIG` block:

| Key | Meaning |
|---|---|
| `slowAfterWeeks` | A line is **Slow** when its stock needs longer than this to clear. Default 26 (six months). |
| `fastUnderWeeks` | A line is **Fast** under this many weeks. Default 8. |
| `shopName`, `shopPlace` | Shown in the header and footer. |

---

## How the numbers are worked out

**Pace.** Pieces sold divided by the number of days there are files for. With four
or more daily files the dashboard switches to this and says so. Until then it
falls back to the full-period export's average, and the panel tells you how many
more daily files are needed.

**Weeks to clear.** Stock on hand divided by that pace. This is what Fast, Steady,
Slow and Dead are built on — a line bought in September that has moved 40% in
three weeks is fast; the same 40% over eight months is not.

**Days idle.** Days since the last file that recorded a sale of that design.

**Seller.** From the Supplier column of a full-period export. Daily exports do not
have this column, so upload a full export whenever you want the seller map
refreshed — monthly is plenty unless you add new suppliers often.

### Things to know

- `TotOut` is read as *sold*. If that column also counts transfers to another
  branch or returns to a supplier, every pace here runs fast.
- The full-period export's header ends at the financial year end (31 March), not
  the day it was run, so the app takes the real date from the **filename**
  (`ASR_GS__S_05.10.26_1.xlsx` → 5 October 2026). Keep that naming.
- Designs are matched by design code, upper-cased with punctuation removed, so
  `25000/BAN` and `25000 BAN` are the same line.
- A design listed under several buying cities is added up, not overwritten.
- Uploading the same report twice is detected and skipped.
- There are no prices anywhere in the ASR export, so everything here is in pieces.
  Add a cost or MRP column and margin becomes possible.

---

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure and the config block |
| `styles.css` | All styling, light and dark |
| `storage.js` | Local browser database and the Google Cloud Storage backend |
| `compute.js` | Workbook parsing and every calculation |
| `matcher.js` | Reads the tag and turns the text into a design code |
| `app.js` | Intake, charts, tables, the uploaded-files dialog |
| `vendor/` | SheetJS and JSZip, bundled so the page needs no CDN |
| `ocr/` | PaddleOCR PP-OCRv4 and the WebAssembly runtime, bundled the same way |

`compute.js` has no dependency on the page — the same file can run in Node if you
ever want a scheduled job to do the computing instead of the browser.

---

## If something looks wrong

**"Could not reach storage"** — the bucket name, client ID, or CORS is off. The app
keeps working against browser storage so nothing is lost; fix the config and
reload.

**A seller column full of dashes** — no full-period export has been loaded yet.

**Pace looks too fast or too slow** — check how many daily files are on record via
the Uploaded files button. Fewer than four and it is still using the period
average.

**A bad file got in** — open Uploaded files and press **Remove** on its row, then
**Yes**. The dashboard keeps every workbook exactly as uploaded, so removing one
reads the others again and rebuilds from them: totals, stock on hand and the
seller map come out exactly as if the removed file had never been loaded.
Photographs and their codes are untouched.

Files uploaded before this version were stored without a link back to their
record, so they cannot be read again. Removing one of those works on the merged
totals instead and tells you if anything needs uploading again. Uploading those
workbooks once more makes them fully removable.

**Clear everything** asks for a second press within four seconds rather than a
pop-up — browsers block pop-ups inside embedded previews, which is why the
buttons used to do nothing there.
