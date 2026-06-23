psql "$DATABASE_URL" -c "SELECT count(*) AS total,
       count(*) FILTER (WHERE abstained IS NOT NULL) AS abstained
FROM retrieval_log WHERE created_at > now() - interval '24 hours';"

psql "$DATABASE_URL" -c "SELECT round(top_similarity::numeric,1) AS bucket, count(*)
FROM retrieval_log WHERE created_at > now() - interval '7 days'
GROUP BY bucket ORDER BY bucket;"

psql "$DATABASE_URL" -c "SELECT count(*) FROM retrieval_log
WHERE abstained IS NULL AND cited_policy_ids = '[]' AND retrieved_policy_ids <> '[]';"
