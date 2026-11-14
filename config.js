/* CONFIGURATION — edit this file only. Shared by every page of the desk.
   Leave api and gcsBucket empty to run entirely in the browser (local mode).
   See README.md. */
window.NARSINGH_CONFIG = {
  gcsBucket:      "",            // e.g. "narsingh-stock-data"
  gcsPrefix:      "stock/",      // folder inside the bucket
  googleClientId: "",            // OAuth client ID ending in .apps.googleusercontent.com
  shopName:       "Shri Narsingh Fashions LLP",
  shopPlace:      "A S Rao Nagar, Hyderabad",
  slowAfterWeeks: 26,            // a line is Slow when its stock needs longer than this to clear
  fastUnderWeeks: 8,

  // The shop's cloud service (api/ in this repository, deployed to Cloud Run).
  // Set: tags are read in Google Cloud and every file and the history are kept
  // there, so any computer opening this page sees the same dashboard.
  // Empty: everything happens in this browser, as before.
  api: "https://stock-desk-api-jgfr5erpxq-el.a.run.app",

  // Reading tags in the browser: PaddleOCR's PP-OCRv4 models, used when api is
  // empty, or if the cloud service cannot be reached. Keep the ocr/ folder
  // next to this file.
  ocr: {
    path: "ocr/"                 // where ocr.bundle.js, models/ and ort/ live
  },
  tagMatcher: {
    column: "C. REF"             // the workbook column codes are matched against
  }
};
