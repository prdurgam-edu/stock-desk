#!/usr/bin/env bash
# Deploys the shop's cloud service to Cloud Run. Run it in Google Cloud Shell
# (shell.cloud.google.com), which is already signed in and has gcloud:
#
#   git clone https://github.com/prdurgam-edu/stock-desk.git && cd stock-desk && bash api/deploy.sh
#
# Safe to run again: it updates the service in place and keeps the bucket.
set -euo pipefail

PROJECT="${PROJECT:-project-2091804d-e7bc-4992-b42}"
REGION="${REGION:-asia-south1}"                      # Mumbai, beside tag-matcher
SERVICE="${SERVICE:-stock-desk-api}"
BUCKET="${BUCKET:-${PROJECT}-stock-desk}"
SITE="${SITE:-https://prdurgam-edu.github.io}"       # the only site allowed to call it

cd "$(dirname "$0")/.."                              # repository root, where the Dockerfile is

echo "== Project $PROJECT, region $REGION"
gcloud config set project "$PROJECT" --quiet
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com cloudtasks.googleapis.com --quiet

echo "== Storage: gs://$BUCKET (private; only the service can read it)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="${NUM}-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin --quiet >/dev/null

echo "== Reading queue: Cloud Tasks calls the service once per photograph, six at a time"
QUEUE="${QUEUE:-stock-desk-reads}"
if ! gcloud tasks queues describe "$QUEUE" --location="$REGION" >/dev/null 2>&1; then
  gcloud tasks queues create "$QUEUE" --location="$REGION" --quiet \
    --max-concurrent-dispatches=6 --max-dispatches-per-second=5 \
    --max-attempts=8 --min-backoff=10s --max-backoff=300s
fi
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/cloudtasks.enqueuer --condition=None --quiet >/dev/null
TASKS_QUEUE="projects/$PROJECT/locations/$REGION/queues/$QUEUE"

echo "== Building and deploying $SERVICE (3 to 5 minutes)"
gcloud run deploy "$SERVICE" --source . --region "$REGION" \
  --allow-unauthenticated --service-account "$SA" \
  --memory 2Gi --cpu 2 --cpu-boost --concurrency 8 --timeout 300 \
  --min-instances 0 --max-instances 6 \
  --set-env-vars "BUCKET=$BUCKET,ALLOWED_ORIGINS=$SITE,TASKS_QUEUE=$TASKS_QUEUE" --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "== Self-test (the first call wakes the service; give it up to a minute)"
curl -s --max-time 120 "$URL/api/selftest"; echo
echo
echo "Service address: $URL"
echo "In index.html, set:   api: \"$URL\","
