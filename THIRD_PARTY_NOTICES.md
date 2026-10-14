# Third-party software

This site bundles the following, unmodified, so that it needs no CDN or server.

| Component | Where | Licence |
|---|---|---|
| [SheetJS](https://sheetjs.com) `xlsx` 0.18.5 | `vendor/xlsx.full.min.js` | Apache-2.0 |
| [JSZip](https://stuk.github.io/jszip/) 3.10.1 | `vendor/jszip.min.js` | MIT (dual MIT / GPL-3.0; used under MIT) |
| [ONNX Runtime Web](https://onnxruntime.ai) 1.30.0 | `ocr/ocr.bundle.js.part*`, `ocr/ort/` | MIT |
| [@gutenye/ocr-browser](https://github.com/gutenye/ocr) 1.4.9 | `ocr/ocr.bundle.js.part*` | MIT |
| [OpenCV.js](https://github.com/TechStark/opencv-js) 4.9.0 | `ocr/ocr.bundle.js.part*` | Apache-2.0 |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv4 detection and recognition models, ONNX export | `ocr/models/` | Apache-2.0 |

Each component remains under its own licence. The full licence texts are at the
links above. Three large files are stored in two halves (`.part1`, `.part2`);
the site joins them in memory, byte for byte.
