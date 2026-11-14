# The shop's cloud service (api/), built for Cloud Run.
# Built from the repository root so the reader's models come from ocr/models,
# the same files the page uses: there is only one copy of them to keep.
# Stage 1: the look-alike model for "Should I buy?". ResNet-50 from the ONNX
# model zoo, cut at its pooling layer (api/make_features.py), so the
# 98 MB model is fetched at build time and never kept in this repository.
FROM python:3.12-slim AS looks
RUN pip install --no-cache-dir onnx==1.23.2
COPY api/make_features.py /make_features.py
RUN python /make_features.py zoo /looks.onnx

# Stage 2: the service
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY api/package.json api/package-lock.json ./
# --ignore-scripts: the native runtime's own binaries ship inside the package;
# its install script only fetches optional GPU libraries this service never uses
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32 \
           node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
 && npm cache clean --force

COPY ocr/models/ch_PP-OCRv4_det_infer.onnx ocr/models/ppocr_keys_v1.txt \
     ocr/models/ch_PP-OCRv4_rec_infer.onnx.part1 ocr/models/ch_PP-OCRv4_rec_infer.onnx.part2 ./models/
RUN cat models/ch_PP-OCRv4_rec_infer.onnx.part1 models/ch_PP-OCRv4_rec_infer.onnx.part2 \
      > models/ch_PP-OCRv4_rec_infer.onnx \
 && rm models/*.part1 models/*.part2

COPY --from=looks /looks.onnx ./models/looks.onnx
COPY api/server.js api/selftest.jpg ./
USER node
CMD ["node", "server.js"]
