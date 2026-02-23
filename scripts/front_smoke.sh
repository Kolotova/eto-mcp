#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_KEY="${KEY:-${API_KEY:-devkey}}"

ok()   { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
skip() { echo "[SKIP] $1"; }
info() { echo "[INFO] $1"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"; }

rpc_call() {
  local payload="$1"
  curl -sS -X POST "$BASE_URL/mcp" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$payload"
}

assert_eq() {
  local name="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] && ok "$name" || fail "$name (expected='$expected' got='$actual')"
}

assert_ne() {
  local name="$1" a="$2" b="$3"
  [[ "$a" != "$b" ]] && ok "$name" || fail "$name (expected different values, got same: '$a')"
}

assert_true() {
  local name="$1" expr="$2"
  [[ "$expr" == "true" ]] && ok "$name" || fail "$name"
}

need curl
need jq

info "BASE_URL=$BASE_URL"
info "API_KEY=<set>"

curl -sS "$BASE_URL/health" | jq -e '.ok == true' >/dev/null && ok "health endpoint" || fail "health endpoint"

rpc_call '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq -e '.result.tools[]?.name == "search_tours"' >/dev/null \
  && ok "tools/list contains search_tours" || fail "tools/list contains search_tours"

COUNTRIES=(
  "47|Turkey|🇹🇷|turkey"
  "54|Egypt|🇪🇬|egypt"
  "29|Thailand|🇹🇭|thailand"
  "63|UAE|🇦🇪|uae"
  "90|Maldives|🇲🇻|maldives"
  "91|Seychelles|🇸🇨|seychelles"
)

for row in "${COUNTRIES[@]}"; do
  cid="${row%%|*}"
  rest="${row#*|}"
  cname="${rest%%|*}"
  rest="${rest#*|}"
  cflag="${rest%%|*}"
  rest="${rest#*|}"
  cslug="$rest"

  resp="$(rpc_call "{\"jsonrpc\":\"2.0\",\"id\":$cid,\"method\":\"tools/call\",\"params\":{\"name\":\"search_tours\",\"arguments\":{\"country_id\":$cid,\"departure_id\":1,\"date_from\":\"2026-06-01\",\"date_to\":\"2026-06-20\",\"nights_min\":6,\"nights_max\":10,\"adults\":2,\"children\":0,\"seed\":\"front-cid-$cid\"}}}")"

  got_name="$(echo "$resp" | jq -r '.result.structuredContent.results[0].country_name // empty')"
  got_flag="$(echo "$resp" | jq -r '.result.structuredContent.results[0].flag_emoji // empty')"

  assert_eq "country_id=$cid country_name" "$got_name" "$cname"
  assert_eq "country_id=$cid flag_emoji" "$got_flag" "$cflag"

  img="$(echo "$resp" | jq -r '.result.structuredContent.results[0].image_url // empty')"
  if [[ -n "$img" && "$img" != "null" ]]; then
    echo "$img" | grep -Eq "^/assets/hotels/${cslug}/${cslug}_[0-9]{2}\.jpg$" \
      && ok "country_id=$cid image_url format" \
      || fail "country_id=$cid image_url bad format: $img"
  else
    ok "country_id=$cid image_url may be empty (no local assets)"
  fi
done

seychelles_asset_status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/assets/hotels/seychelles/seychelles_01.jpg")"
assert_eq "seychelles asset HTTP 200" "$seychelles_asset_status" "200"

resp_seychelles_images="$(rpc_call '{"jsonrpc":"2.0","id":92,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":91,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"limit":5,"offset":0,"seed":"front-seychelles-images"}}}')"
assert_true "Seychelles first 5 image_url non-empty expected format" "$(echo "$resp_seychelles_images" | jq -r '
  (.result.structuredContent.results[:5] | length) as $len
  | if $len == 0 then false
    else (.result.structuredContent.results[:5] | all(
      (.image_url | type == "string")
      and (.image_url | length > 0)
      and (.image_url | startswith("/assets/hotels/seychelles/"))
      and (.image_url | test("^/assets/hotels/seychelles/seychelles_[0-9]{2}\\.(jpg|jpeg|png)$"))
    )) end
')"

resp_budget="$(rpc_call '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"budget_max":65000,"seed":"front-budget"}}}')"

count_budget="$(echo "$resp_budget" | jq -r '.result.structuredContent.results | length')"
if [[ "$count_budget" == "0" ]]; then
  ok "budget filter (no results acceptable)"
else
  assert_true "budget filter max<=65000" "$(echo "$resp_budget" | jq -r '([.result.structuredContent.results[].price] | max) <= 65000')"
fi

resp_rating="$(rpc_call '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":54,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"rating":4.6,"seed":"front-rating"}}}')"

count_rating="$(echo "$resp_rating" | jq -r '.result.structuredContent.results | length')"
if [[ "$count_rating" == "0" ]]; then
  ok "rating_min filter (no results acceptable)"
else
  assert_true "rating_min filter min>=4.6" "$(echo "$resp_rating" | jq -r '([.result.structuredContent.results[].rating] | min) >= 4.6')"
fi

resp_meal="$(rpc_call '{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":29,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"meal":"AI","seed":"front-meal"}}}')"

uniq_meal="$(echo "$resp_meal" | jq -r '[.result.structuredContent.results[].meal] | unique | @json')"
if [[ "$uniq_meal" == "[]" ]]; then
  ok "meal filter (no results acceptable)"
else
  assert_eq "meal filter unique==[AI]" "$uniq_meal" '["AI"]'
fi

resp_asc="$(rpc_call '{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":63,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"sort":"price_asc","seed":"front-sort"}}}')"
resp_desc="$(rpc_call '{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":63,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"sort":"price_desc","seed":"front-sort"}}}')"

assert_true "sort price_asc monotonic" "$(echo "$resp_asc" | jq -r '(.result.structuredContent.results | map(.price)) as $p | ($p == ($p|sort))')"
ids_asc="$(echo "$resp_asc" | jq -r '.result.structuredContent.results | map(.hotel_id) | @json')"
ids_desc="$(echo "$resp_desc" | jq -r '.result.structuredContent.results | map(.hotel_id) | @json')"
assert_true "sort price_desc monotonic" "$(echo "$resp_desc" | jq -r '(.result.structuredContent.results | map(.price)) as $p | ($p == ($p|sort|reverse))')"
assert_ne "sort price_desc order differs from price_asc" "$ids_desc" "$ids_asc"

resp_p1="$(rpc_call '{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-page","limit":3,"offset":0}}}')"
resp_p2="$(rpc_call '{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-page","limit":3,"offset":3}}}')"

ids1="$(echo "$resp_p1" | jq -r '.result.structuredContent.results | map(.hotel_id) | @json')"
ids2="$(echo "$resp_p2" | jq -r '.result.structuredContent.results | map(.hotel_id) | @json')"

assert_ne "pagination page1 != page2" "$ids1" "$ids2"

img_p1_resp="$(rpc_call '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-images","limit":5,"offset":0}}}')"
img_p2_resp="$(rpc_call '{"jsonrpc":"2.0","id":43,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-images","limit":5,"offset":5}}}')"
img_p1_repeat="$(rpc_call '{"jsonrpc":"2.0","id":44,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-images","limit":5,"offset":0}}}')"

imgs1="$(echo "$img_p1_resp" | jq -r '.result.structuredContent.results | map(.image_url // "") | @json')"
imgs1_repeat="$(echo "$img_p1_repeat" | jq -r '.result.structuredContent.results | map(.image_url // "") | @json')"
assert_eq "image determinism (first 5 image_url stable)" "$imgs1" "$imgs1_repeat"

img_present_count="$(echo "$img_p1_resp" | jq -r '[.result.structuredContent.results[].image_url | select(type=="string" and length>0)] | length')"
if (( img_present_count < 3 )); then
  skip "image diversity check (not enough local assets in page)"
else
  img_unique_count="$(echo "$img_p1_resp" | jq -r '[.result.structuredContent.results[].image_url | select(type=="string" and length>0)] | unique | length')"
  if (( img_unique_count >= 3 )); then
    ok "image diversity page1 (>=3 unique in first 5)"
  else
    fail "image diversity page1 (expected >=3 unique image_url, got $img_unique_count)"
  fi

  img_overlap="$(echo "$img_p1_resp" "$img_p2_resp" | jq -s -r '
    (.[0].result.structuredContent.results | map(.image_url // "") | map(select(length>0))) as $a
    | (.[1].result.structuredContent.results | map(.image_url // "") | map(select(length>0))) as $b
    | [$a[] | select(. as $x | $b | index($x) != null)] | unique | length
  ')"
  if (( img_overlap < 5 )); then
    ok "image rotation across pages"
  else
    fail "image rotation across pages (all images repeated)"
  fi
fi

d1="$(rpc_call '{"jsonrpc":"2.0","id":50,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":90,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-determinism","limit":3,"offset":0}}}' \
  | jq -r '.result.structuredContent.results | map({hotel_id,price,image_url}) | @json')"

d2="$(rpc_call '{"jsonrpc":"2.0","id":51,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_id":90,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-determinism","limit":3,"offset":0}}}' \
  | jq -r '.result.structuredContent.results | map({hotel_id,price,image_url}) | @json')"

assert_eq "determinism (first 3 stable)" "$d1" "$d2"

resp_noid="$(rpc_call '{"jsonrpc":"2.0","id":60,"method":"tools/call","params":{"name":"search_tours","arguments":{"country_name":"Maldives","departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":0,"seed":"front-noid","limit":1,"offset":0}}}')"

noid_country="$(echo "$resp_noid" | jq -r '.result.structuredContent.results[0].country_name // empty')"

assert_eq "no-country_id routing via country_name" "$noid_country" "Maldives"

info "All front smoke tests passed"
