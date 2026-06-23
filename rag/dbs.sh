ls node_modules >/dev/null 2>&1 && echo "deps ok" || npm install
grep DATABASE_URL .env           # must show :5433
set -a; source .env; set +a
echo "$DATABASE_URL"             # confirm :5433
