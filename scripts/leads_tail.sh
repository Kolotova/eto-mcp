#!/usr/bin/env bash
set -euo pipefail

mkdir -p data
if [[ ! -f data/leads.jsonl ]]; then
  touch data/leads.jsonl
fi

tail -n 20 data/leads.jsonl
