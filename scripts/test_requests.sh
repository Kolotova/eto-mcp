#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_KEY="${API_KEY:-devkey}"

HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=1
fi

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

pass() {
  echo "[PASS] $*"
}

call_mcp_raw() {
  local payload="$1"
  curl -fsS -X POST "$BASE_URL/mcp" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$payload"
}

call_search_tours() {
  local args_json="$1"
  local req_id="$2"
  call_mcp_raw "{\"jsonrpc\":\"2.0\",\"id\":$req_id,\"method\":\"tools/call\",\"params\":{\"name\":\"search_tours\",\"arguments\":$args_json}}"
}

echo "[INFO] BASE_URL=$BASE_URL"
echo "[INFO] API_KEY=<set>"

health_resp="$(curl -fsS "$BASE_URL/health")"
if [[ "$HAS_JQ" -eq 1 ]]; then
  [[ "$(echo "$health_resp" | jq -r '.ok // false')" == "true" ]] || fail "/health did not return ok=true"
else
  echo "$health_resp" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || fail "/health did not return ok=true"
fi
pass "health endpoint"

list_resp="$(call_mcp_raw '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
if [[ "$HAS_JQ" -eq 1 ]]; then
  echo "$list_resp" | jq -e '.result.tools[] | select(.name=="search_tours")' >/dev/null || fail "search_tours not found in tools/list"
else
  echo "$list_resp" | grep -q '"name":"search_tours"' || fail "search_tours not found in tools/list"
fi
pass "tools/list contains search_tours"

turkey_args='{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":1,"seed":"turkey-case"}'
egypt_args='{"country_id":54,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":1,"seed":"egypt-case"}'
maldives_args='{"country_id":90,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":1,"seed":"maldives-case"}'
seychelles_args='{"country_id":91,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":1,"seed":"seychelles-case"}'
turkey_rating_args='{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":1,"rating":4.6,"seed":"turkey-rating"}'
turkey_budget_args='{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":6,"nights_max":10,"adults":2,"children":1,"budget_max":100000,"seed":"turkey-budget"}'
turkey_n3_args='{"country_id":47,"departure_id":1,"date_from":"2026-06-01","date_to":"2026-06-20","nights_min":3,"nights_max":3,"adults":2,"children":1,"seed":"turkey-n3","limit":5}'

resp_turkey="$(call_search_tours "$turkey_args" 11)"
resp_egypt="$(call_search_tours "$egypt_args" 12)"
resp_maldives="$(call_search_tours "$maldives_args" 13)"
resp_seychelles="$(call_search_tours "$seychelles_args" 14)"
resp_turkey_rating="$(call_search_tours "$turkey_rating_args" 15)"
resp_turkey_budget="$(call_search_tours "$turkey_budget_args" 16)"
resp_turkey_n3="$(call_search_tours "$turkey_n3_args" 17)"

if [[ "$HAS_JQ" -eq 1 ]]; then
  text_turkey="$(echo "$resp_turkey" | jq -r '.result.content[0].text // ""')"
  len_turkey="$(echo "$resp_turkey" | jq '.result.structuredContent.results | length')"
  len_turkey_rating="$(echo "$resp_turkey_rating" | jq '.result.structuredContent.results | length')"

  echo "$text_turkey" | grep -q "<b>" || fail "formatter check failed: no <b>"
  echo "$text_turkey" | grep -q "⭐️" || fail "formatter check failed: no ⭐️"
  echo "$text_turkey" | grep -q "📍" || fail "formatter check failed: no location line"
  (( ${#text_turkey} < 4000 )) || fail "formatter check failed: content.text length >= 4000"
  pass "telegram formatter content.text"

  (( len_turkey > 0 )) || fail "Turkey query returned 0 results"
  echo "$resp_turkey" | jq -e '.result.structuredContent.results | all(.country_name == "Turkey" and .flag_emoji == "🇹🇷" and ((.city_name // "") != ""))' >/dev/null || fail "Turkey results country/city/flag mismatch"
  pass "Turkey country/flag/city mapping"

  echo "$resp_egypt" | jq -e '.result.structuredContent.results | all(.country_name == "Egypt" and .flag_emoji == "🇪🇬" and ((.city_name // "") != ""))' >/dev/null || fail "Egypt results country/city/flag mismatch"
  pass "Egypt country/flag/city mapping"

  echo "$resp_maldives" | jq -e '.result.structuredContent.results | all(.country_name == "Maldives" and .flag_emoji == "🇲🇻" and ((.city_name // "") != ""))' >/dev/null || fail "Maldives results country/city/flag mismatch"
  pass "Maldives country/flag/city mapping"

  echo "$resp_seychelles" | jq -e '.result.structuredContent.results | all(.country_name == "Seychelles" and .flag_emoji == "🇸🇨" and ((.city_name // "") != ""))' >/dev/null || fail "Seychelles results country/city/flag mismatch"
  pass "Seychelles country/flag/city mapping"

  echo "$resp_turkey" | jq -e '.result.structuredContent.results | all(((.image_url == null) or (.image_url == "") or ((.image_url | startswith("/assets/hotels/turkey/")) and (.image_url | contains("turkey_")))))' >/dev/null || fail "Turkey image_url format mismatch"
  echo "$resp_egypt" | jq -e '.result.structuredContent.results | all(((.image_url == null) or (.image_url == "") or ((.image_url | startswith("/assets/hotels/egypt/")) and (.image_url | contains("egypt_")))))' >/dev/null || fail "Egypt image_url format mismatch"
  echo "$resp_maldives" | jq -e '.result.structuredContent.results | all(((.image_url == null) or (.image_url == "") or ((.image_url | startswith("/assets/hotels/maldives/")) and (.image_url | contains("maldives_")))))' >/dev/null || fail "Maldives image_url format mismatch"
  echo "$resp_seychelles" | jq -e '.result.structuredContent.results | all(((.image_url == null) or (.image_url == "") or ((.image_url | startswith("/assets/hotels/seychelles/")) and (.image_url | contains("seychelles_")))))' >/dev/null || fail "Seychelles image_url format mismatch"
  pass "image_url local path format by country slug"

  (( len_turkey_rating <= len_turkey )) || fail "Turkey rating filter did not reduce/keep result count"
  (( len_turkey_rating > 0 )) || fail "Turkey rating filter returned 0 results"
  pass "Turkey rating filter"

  echo "$resp_turkey_budget" | jq -e '.result.structuredContent.results | all(.price <= 100000)' >/dev/null || fail "Turkey budget filter mismatch"
  pass "Turkey budget filter"

  n3_len="$(echo "$resp_turkey_n3" | jq '.result.structuredContent.results | length')"
  (( n3_len > 0 )) || fail "Turkey nights=3 query returned 0 results"
  echo "$resp_turkey_n3" | jq -e '.result.structuredContent.results[:5] | all(.nights == 3)' >/dev/null || fail "Turkey nights=3 results mismatch"
  pass "Turkey nights_min/max=3 honored"

  resp_det_1="$(call_search_tours "$turkey_args" 21)"
  resp_det_2="$(call_search_tours "$turkey_args" 22)"

  reqid_1="$(echo "$resp_det_1" | jq -r '.result.structuredContent.requestid')"
  reqid_2="$(echo "$resp_det_2" | jq -r '.result.structuredContent.requestid')"
  [[ "$reqid_1" == "$reqid_2" ]] || fail "determinism failed: requestid differs"

  first3_1="$(echo "$resp_det_1" | jq -c '.result.structuredContent.results[:3]')"
  first3_2="$(echo "$resp_det_2" | jq -c '.result.structuredContent.results[:3]')"
  [[ "$first3_1" == "$first3_2" ]] || fail "determinism failed: first 3 results differ"
  pass "determinism (requestid + first 3 with image_url)"

  resp_sey_det_1="$(call_search_tours "$seychelles_args" 23)"
  resp_sey_det_2="$(call_search_tours "$seychelles_args" 24)"
  sey_1="$(echo "$resp_sey_det_1" | jq -c '.result.structuredContent.results[:3] | map({hotel_id, image_url})')"
  sey_2="$(echo "$resp_sey_det_2" | jq -c '.result.structuredContent.results[:3] | map({hotel_id, image_url})')"
  [[ "$sey_1" == "$sey_2" ]] || fail "Seychelles determinism failed (first 3)"
  pass "Seychelles determinism (first 3 with image_url)"
else
  echo "[WARN] jq not found; using basic grep/awk fallback checks"

  echo "$resp_turkey" | grep -q "Turkey" || fail "Turkey fallback check failed"
  echo "$resp_turkey" | grep -q "🇹🇷" || fail "Turkey flag fallback check failed"
  echo "$resp_egypt" | grep -q "Egypt" || fail "Egypt fallback check failed"
  echo "$resp_egypt" | grep -q "🇪🇬" || fail "Egypt flag fallback check failed"
  echo "$resp_maldives" | grep -q "Maldives" || fail "Maldives fallback check failed"
  echo "$resp_maldives" | grep -q "🇲🇻" || fail "Maldives flag fallback check failed"
  echo "$resp_seychelles" | grep -q "Seychelles" || fail "Seychelles fallback check failed"
  echo "$resp_seychelles" | grep -q "🇸🇨" || fail "Seychelles flag fallback check failed"
  pass "country/flag mapping fallback"

  echo "$resp_turkey" | grep -q '<b>' || fail "formatter fallback check failed: no <b>"
  echo "$resp_turkey" | grep -q "⭐️" || fail "formatter fallback check failed: no ⭐️"
  echo "$resp_turkey" | grep -q "📍" || fail "formatter fallback check failed: no location"
  pass "telegram formatter content.text (fallback check)"

  if echo "$resp_turkey" | grep -q '"image_url":"'; then
    echo "$resp_turkey" | grep -q '"image_url":"/assets/hotels/turkey/' || fail "Turkey image_url fallback path mismatch"
  fi
  if echo "$resp_egypt" | grep -q '"image_url":"'; then
    echo "$resp_egypt" | grep -q '"image_url":"/assets/hotels/egypt/' || fail "Egypt image_url fallback path mismatch"
  fi
  if echo "$resp_maldives" | grep -q '"image_url":"'; then
    echo "$resp_maldives" | grep -q '"image_url":"/assets/hotels/maldives/' || fail "Maldives image_url fallback path mismatch"
  fi
  if echo "$resp_seychelles" | grep -q '"image_url":"'; then
    echo "$resp_seychelles" | grep -q '"image_url":"/assets/hotels/seychelles/' || fail "Seychelles image_url fallback path mismatch"
  fi
  pass "image_url local path format by country slug (fallback)"

  echo "$resp_turkey_n3" | grep -q '"nights":3' || fail "Turkey nights=3 fallback check failed"
  pass "Turkey nights_min/max=3 honored (fallback)"

  resp_det_1="$(call_search_tours "$turkey_args" 21)"
  resp_det_2="$(call_search_tours "$turkey_args" 22)"
  reqid_1="$(echo "$resp_det_1" | awk -F'"requestid":"' '{print $2}' | awk -F'"' '{print $1}' | head -n1)"
  reqid_2="$(echo "$resp_det_2" | awk -F'"requestid":"' '{print $2}' | awk -F'"' '{print $1}' | head -n1)"
  [[ -n "$reqid_1" && "$reqid_1" == "$reqid_2" ]] || fail "determinism fallback check failed"
  pass "determinism by requestid (fallback)"
fi

echo "[OK] All test requests passed"
